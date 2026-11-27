import type { QueryResult, RowMode, SqlExecutor, OpenOptions } from "./types";
import { lazyExecutor, normalizeParam } from "./types";

/** bigint and numeric arrive as strings by default; every count, sum and timestamp in the app is a number. */
const INT8 = 20;
const NUMERIC = 1700;

function params(values: unknown[]) {
	return values.map(normalizeParam);
}

// ---- node-postgres (also Supabase, Neon over TCP, RDS, Hyperdrive) ----

type PgQueryable = {
	query(config: { text: string; values: unknown[]; rowMode?: "array"; types?: unknown }): Promise<{ rows: unknown[]; rowCount: number | null }>;
};

function pgExecutor(queryable: PgQueryable, types: unknown, inTransaction?: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>): SqlExecutor {
	return {
		dialect: "postgres",
		async query(text, values, mode: RowMode): Promise<QueryResult> {
			const result = await queryable.query({ text, values: params(values), rowMode: mode === "array" ? "array" : undefined, types });
			return { rows: result.rows, affectedRows: result.rowCount ?? 0 };
		},
		transaction: inTransaction,
	};
}

export function openNodePostgres({ url, shared }: OpenOptions): SqlExecutor {
	return lazyExecutor("postgres", async () => {
		const pg = await import("pg");
		const { Pool, Client, types: pgTypes } = (pg as unknown as { default?: typeof pg }).default ?? pg;
		const types = {
			getTypeParser: (oid: number, format?: "text" | "binary") =>
				oid === INT8 || oid === NUMERIC ? (value: string) => Number(value) : pgTypes.getTypeParser(oid as never, format as never),
		};
		// TLS follows the connection string (`sslmode=require` etc.), as node-postgres parses it.
		const config = { connectionString: url };

		if (shared) {
			const pool = new Pool({ ...config, max: 10 });
			// An idle connection dropped by the server would otherwise crash the process with an unhandled event.
			pool.on("error", (error: Error) => console.error("Postgres pool error:", error.message));
			const run = async <T,>(fn: (tx: SqlExecutor) => Promise<T>) => {
				const client = await pool.connect();
				try {
					await client.query("BEGIN");
					const result = await fn(pgExecutor(client as unknown as PgQueryable, types));
					await client.query("COMMIT");
					return result;
				} catch (error) {
					await client.query("ROLLBACK").catch(() => undefined);
					throw error;
				} finally {
					client.release();
				}
			};
			return { ...pgExecutor(pool as unknown as PgQueryable, types, run), close: () => pool.end() };
		}

		// Workers: sockets cannot outlive the request that opened them, so connect per use (Hyperdrive pools behind this).
		const withClient = async <T,>(fn: (client: InstanceType<typeof Client>) => Promise<T>) => {
			const client = new Client({ ...config, connectionTimeoutMillis: 10_000 });
			await client.connect();
			try {
				return await fn(client);
			} finally {
				await client.end().catch(() => undefined);
			}
		};
		return {
			dialect: "postgres",
			query: (text, values, mode) => withClient((client) => pgExecutor(client as unknown as PgQueryable, types).query(text, values, mode)),
			transaction: (fn) =>
				withClient(async (client) => {
					await client.query("BEGIN");
					try {
						const result = await fn(pgExecutor(client as unknown as PgQueryable, types));
						await client.query("COMMIT");
						return result;
					} catch (error) {
						await client.query("ROLLBACK").catch(() => undefined);
						throw error;
					}
				}),
		};
	});
}

// ---- postgres.js ----

export function openPostgresJs({ url, shared }: OpenOptions): SqlExecutor {
	return lazyExecutor("postgres", async () => {
		const imported = await import("postgres");
		const postgres = (imported as unknown as { default: typeof imported.default }).default;
		const make = () =>
			postgres(url, {
				max: shared ? 10 : 1,
				prepare: false,
				onnotice: () => undefined,
				types: {
					bigint: { to: INT8, from: [INT8], serialize: (value: unknown) => String(value), parse: (value: string) => Number(value) },
					numeric: { to: NUMERIC, from: [NUMERIC], serialize: (value: unknown) => String(value), parse: (value: string) => Number(value) },
				},
			});
		type Sql = ReturnType<typeof make>;
		const executorFor = (sql: Sql | { unsafe: Sql["unsafe"] }, transaction?: SqlExecutor["transaction"]): SqlExecutor => ({
			dialect: "postgres",
			async query(text, values, mode) {
				const statement = sql.unsafe(text, params(values) as never);
				if (mode === "array") {
					const result = await statement.values();
					return { rows: result as unknown[], affectedRows: (result as { count?: number }).count ?? result.length };
				}
				const result = await statement;
				return { rows: [...result], affectedRows: (result as unknown as { count?: number }).count ?? result.length };
			},
			transaction,
		});
		if (shared) {
			const sql = make();
			return {
				...executorFor(sql, (fn) => sql.begin((tx) => fn(executorFor(tx as unknown as Sql))) as never),
				close: () => sql.end(),
			};
		}
		return {
			dialect: "postgres",
			query: async (text, values, mode) => {
				const sql = make();
				try {
					return await executorFor(sql).query(text, values, mode);
				} finally {
					await sql.end({ timeout: 1 }).catch(() => undefined);
				}
			},
			transaction: async (fn) => {
				const sql = make();
				try {
					return (await sql.begin((tx) => fn(executorFor(tx as unknown as Sql)))) as never;
				} finally {
					await sql.end({ timeout: 1 }).catch(() => undefined);
				}
			},
		};
	});
}

// ---- Neon / Vercel Postgres over HTTP (fetch, so it runs anywhere) ----

export function openNeon({ url }: OpenOptions): SqlExecutor {
	return lazyExecutor("postgres", async () => {
		const { neon } = await import("@neondatabase/serverless");
		const sql = neon(url, { fullResults: true });
		return {
			dialect: "postgres",
			async query(text, values, mode) {
				const result = (await sql.query(text, params(values), { arrayMode: mode === "array", fullResults: true } as never)) as unknown as {
					rows: unknown[];
					rowCount: number;
					fields: Array<{ name: string; dataTypeID: number }>;
				};
				// The HTTP protocol returns bigint and numeric as strings; the app expects numbers (as the TCP drivers give).
				const numeric = result.fields.map((field, index) => (field.dataTypeID === INT8 || field.dataTypeID === NUMERIC ? [index, field.name] as const : null)).filter((entry) => entry !== null);
				if (numeric.length > 0) {
					for (const row of result.rows) {
						for (const [index, name] of numeric) {
							const cell = mode === "array" ? (row as unknown[])[index] : (row as Record<string, unknown>)[name];
							if (typeof cell !== "string") continue;
							if (mode === "array") (row as unknown[])[index] = Number(cell);
							else (row as Record<string, unknown>)[name] = Number(cell);
						}
					}
				}
				return { rows: result.rows, affectedRows: result.rowCount ?? 0 };
			},
			// The HTTP protocol has no interactive transaction; batches fall back to sequential statements.
		};
	}, { atomicBatch: false });
}

// ---- PGlite (in-process Postgres on WASM; Node only) ----

export function openPglite({ url }: OpenOptions): SqlExecutor {
	return lazyExecutor("postgres", async () => {
		// Variable specifier: PGlite is large and Node-only, so bundlers must not pull it into the Worker.
		const name = "@electric-sql/pglite";
		const { PGlite } = (await import(/* @vite-ignore */ name)) as typeof import("@electric-sql/pglite");
		const location = url.replace(/^pglite:(\/\/)?/i, "");
		const dataDir = !location || location === "memory" || location === "memory:" ? undefined : location;
		const db = await PGlite.create(dataDir, { parsers: { [INT8]: (value: string) => Number(value), [NUMERIC]: (value: string) => Number(value) } });
		const executorFor = (target: Pick<typeof db, "query">, transaction?: SqlExecutor["transaction"]): SqlExecutor => ({
			dialect: "postgres",
			async query(text, values, mode) {
				const result = await target.query(text, params(values), { rowMode: mode === "array" ? "array" : "object" });
				return { rows: result.rows as unknown[], affectedRows: result.affectedRows ?? result.rows.length };
			},
			transaction,
		});
		return { ...executorFor(db, (fn) => db.transaction((tx) => fn(executorFor(tx as never)))), close: () => db.close() };
	});
}

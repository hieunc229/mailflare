import type { OpenOptions, SqlExecutor } from "./types";
import { lazyExecutor, normalizeParam } from "./types";

const params = (values: unknown[]) => values.map(normalizeParam);

/** TiDB Cloud and most hosted MySQL require TLS; mysql2 only turns it on when asked. */
function sslFor(url: string) {
	return /tidbcloud\.com|[?&]ssl(mode)?=(true|required|require|verify)/i.test(url) ? { minVersion: "TLSv1.2", rejectUnauthorized: true } : undefined;
}

type Queryable = {
	query(options: { sql: string; rowsAsArray?: boolean }, values: unknown[]): Promise<[unknown, unknown]>;
};

function mysqlExecutor(queryable: Queryable, transaction?: SqlExecutor["transaction"], discard?: () => void): SqlExecutor {
	return {
		dialect: "mysql",
		async query(sql, values, mode) {
			const [result] = await queryable.query({ sql, rowsAsArray: mode === "array" }, params(values));
			if (Array.isArray(result)) return { rows: result, affectedRows: result.length };
			const header = result as { affectedRows?: number; insertId?: number };
			return { rows: [], affectedRows: header.affectedRows ?? 0, insertId: header.insertId };
		},
		transaction,
		discard,
	};
}

/** mysql2: MySQL, MariaDB, TiDB, Aurora. */
export function openMysql2({ url, shared }: OpenOptions): SqlExecutor {
	return lazyExecutor("mysql", async () => {
		const mysql = await import("mysql2/promise");
		const lib = (mysql as unknown as { default?: typeof mysql }).default ?? mysql;
		const options = {
			uri: url.replace(/^mysql2:/i, "mysql:").replace(/^mariadb:/i, "mysql:"),
			ssl: sslFor(url),
			decimalNumbers: true,
			supportBigNumbers: true,
			bigNumberStrings: false,
			charset: "utf8mb4",
			timezone: "Z",
		};
		const inTransaction = async <T,>(connection: Awaited<ReturnType<typeof lib.createConnection>>, fn: (tx: SqlExecutor) => Promise<T>, discard?: () => void) => {
			await connection.beginTransaction();
			let discarded = false;
			try {
				const result = await fn(mysqlExecutor(connection as unknown as Queryable, undefined, discard && (() => { discarded = true; discard(); })));
				// A connection the work gave up on (its lock could not be released) may fail here; the work itself finished.
				await connection.commit().catch((error: unknown) => {
					if (!discarded) throw error;
					console.error("COMMIT failed on a discarded connection:", error);
				});
				return result;
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			}
		};
		if (shared) {
			const pool = lib.createPool({ ...options, connectionLimit: 10 });
			return {
				...mysqlExecutor(pool as unknown as Queryable, async (fn) => {
					const connection = await pool.getConnection();
					let broken = false;
					try {
						return await inTransaction(connection as never, fn, () => (broken = true));
					} finally {
						if (broken) connection.destroy();
						else connection.release();
					}
				}),
				close: () => pool.end(),
			};
		}
		const withConnection = async <T,>(fn: (connection: Awaited<ReturnType<typeof lib.createConnection>>) => Promise<T>) => {
			const connection = await lib.createConnection(options);
			try {
				return await fn(connection);
			} finally {
				await connection.end().catch(() => undefined);
			}
		};
		return {
			dialect: "mysql",
			query: (sql, values, mode) => withConnection((connection) => mysqlExecutor(connection as unknown as Queryable).query(sql, values, mode)),
			transaction: (fn) => withConnection((connection) => inTransaction(connection, fn)),
		};
	});
}

/** PlanetScale's HTTP driver (fetch, so it runs on Workers without sockets). */
export function openPlanetScale({ url }: OpenOptions): SqlExecutor {
	return lazyExecutor("mysql", async () => {
		const { connect } = await import("@planetscale/database");
		const cast = (field: { type: string }, value: string | null) => {
			if (value === null) return null;
			if (/^(INT|UINT|YEAR|DECIMAL|FLOAT|DOUBLE)/.test(field.type)) return Number(value);
			return value;
		};
		const connection = connect({ url: url.replace(/^mysql2?:/i, "https:").replace(/^(https:\/\/[^@]*@)/, "$1"), cast } as never);
		type Tx = { execute(sql: string, values?: unknown[], options?: { as?: "array" | "object" }): Promise<{ rows: unknown[]; rowsAffected: number; insertId: string }> };
		const executorFor = (target: Tx, transaction?: SqlExecutor["transaction"]): SqlExecutor => ({
			dialect: "mysql",
			async query(sql, values, mode) {
				const result = await target.execute(sql, params(values), { as: mode === "array" ? "array" : "object" });
				return { rows: result.rows, affectedRows: result.rowsAffected, insertId: result.insertId ? Number(result.insertId) : undefined };
			},
			transaction,
		});
		return executorFor(connection as unknown as Tx, (fn) => connection.transaction((tx) => fn(executorFor(tx as unknown as Tx))));
	});
}

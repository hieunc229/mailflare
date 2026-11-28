import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bundle the migration runner with a synthetic bundle for every dialect (`bundles` maps dialect to migrations).
export async function loadMigrationService(name, bundles) {
	const directory = mkdtempSync(join(root, "node_modules", `${name}-test-`));
	after(() => rmSync(directory, { recursive: true, force: true }));
	const empty = { migrations: [] };
	await build({
		entryPoints: [join(root, "src/lib/migrations/service.ts")],
		outfile: join(directory, "service.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		tsconfig: join(root, "tsconfig.json"),
		packages: "external",
		logLevel: "silent",
		plugins: [{
			name: `${name}-bundles`,
			setup(builder) {
				builder.onResolve({ filter: /\/bundle(-mysql|-postgres)?\.json$/ }, ({ path }) => ({ path, namespace: "bundle" }));
				builder.onLoad({ filter: /.*/, namespace: "bundle" }, ({ path }) => {
					const dialect = path.includes("mysql") ? "mysql" : path.includes("postgres") ? "postgres" : "sqlite";
					return { loader: "json", contents: JSON.stringify(bundles[dialect] ?? empty) };
				});
			},
		}],
	});
	return import(pathToFileURL(join(directory, "service.mjs")).href);
}

// One in-memory server: the ledger tables and the named lock (GET_LOCK / pg_advisory_lock) that replicas share.
export function fakeServer() {
	const waiters = [];
	const server = {
		ledger: new Set(),
		steps: new Set(),
		created: new Set(),
		lockHeld: false,
		lockLog: [],
		async acquire(owner) {
			if (server.lockHeld) await new Promise((resolve) => waiters.push(resolve));
			server.lockHeld = true;
			server.lockLog.push(`acquire ${owner}`);
		},
		release(owner) {
			server.lockLog.push(`release ${owner}`);
			server.lockHeld = false;
			waiters.shift()?.();
		},
	};
	return server;
}

// A client behind the D1-style surface the runner uses. `fail(sql)` may throw (or return a promise) to simulate a driver error;
// `afterRun(sql, ledger)` runs after a statement succeeded (to simulate another replica); `failInsert(name)` makes a ledger
// or progress insert fail (a crash between a statement and its mark).
// `driver` is the config driver name; `lockResult` is what GET_LOCK returns; `failRelease` makes RELEASE_LOCK throw.
export function fakeDatabase(dialect, { fail, afterRun, failInsert, server = fakeServer(), name = "client", driver, lockResult = 1, failRelease = false, lockTimeout = false } = {}) {
	const { ledger, steps } = server;
	const tables = { mailflare_migrations: ledger, mailflare_migration_steps: steps };
	const state = { executed: [], batchCalls: [], connectionQueries: [], discarded: false, ledger, steps, server };
	const table = (sql) => {
		const found = /\b(mailflare_migration_steps|mailflare_migrations)\b/.exec(sql)?.[1];
		if (found && !server.created.has(found)) throw Object.assign(new Error(`Table '${found}' doesn't exist`), { errno: 1146 });
		return tables[found];
	};
	class Statement {
		constructor(sql) {
			this.sql = sql;
			this.args = [];
		}
		bind(...args) {
			this.args = args;
			return this;
		}
		async first() {
			if (this.sql.startsWith("SELECT table_name")) return server.created.has("mailflare_migrations") ? { name: "mailflare_migrations" } : null;
			if (this.sql.includes("WHERE name = ?")) return table(this.sql).has(this.args[0]) ? { name: this.args[0] } : null;
			throw new Error(`unexpected first(): ${this.sql}`);
		}
		async all() {
			if (/^SELECT name FROM mailflare_migration(s|_steps)$/.test(this.sql)) return { results: [...table(this.sql)].map((name) => ({ name })) };
			throw new Error(`unexpected all(): ${this.sql}`);
		}
		async run() {
			const { sql, args } = this;
			const create = /^CREATE TABLE IF NOT EXISTS (mailflare_migration\w*)/.exec(sql);
			const drop = /^DROP TABLE IF EXISTS (mailflare_migration\w*)/.exec(sql);
			if (create) server.created.add(create[1]);
			else if (drop) {
				server.created.delete(drop[1]);
				tables[drop[1]].clear();
			} else if (sql.startsWith("INSERT INTO mailflare_migration")) {
				const rows = table(sql);
				if (failInsert?.(args[0])) throw new Error("connection lost");
				if (rows.has(args[0])) throw Object.assign(new Error("Duplicate entry"), { errno: 1062 });
				rows.add(args[0]);
			} else if (sql.startsWith("DELETE FROM mailflare_migration")) {
				const rows = table(sql);
				const prefix = String(args[0]).replace(/%$/, "");
				for (const row of [...rows]) if (row.startsWith(prefix)) rows.delete(row);
			} else {
				await fail?.(sql);
				state.executed.push(sql);
				afterRun?.(sql, ledger);
			}
			return { success: true };
		}
	}
	const connection = {
		async query(sql) {
			state.connectionQueries.push(sql);
			if (/GET_LOCK/.test(sql)) {
				if (lockResult === 1) await server.acquire(name);
				return { rows: [{ acquired: lockResult }], affectedRows: 1 };
			}
			if (/pg_advisory_xact_lock/.test(sql)) {
				if (lockTimeout) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
				await server.acquire(name);
				state.holdsXactLock = true;
				return { rows: [{}], affectedRows: 1 };
			}
			if (/RELEASE_LOCK/.test(sql)) {
				if (failRelease) throw new Error("connection lost");
				server.release(name);
				return { rows: [{ released: 1 }], affectedRows: 1 };
			}
			if (/^SET (TRANSACTION|LOCAL)/.test(sql)) return { rows: [], affectedRows: 0 };
			throw new Error(`unexpected connection query: ${sql}`);
		},
		discard() {
			state.discarded = true;
		},
	};
	// COMMIT or ROLLBACK frees a transaction-scoped advisory lock, however the work ended.
	const transaction = async (fn) => {
		try {
			return await fn(connection);
		} finally {
			if (state.holdsXactLock) {
				state.holdsXactLock = false;
				server.release(name);
			}
		}
	};
	return {
		state,
		createDrizzle() {},
		config: { dialect, driver: driver ?? (dialect === "mysql" ? "mysql2" : "node-postgres") },
		sqlExecutor: { dialect, query: connection.query, transaction },
		prepare: (sql) => new Statement(sql),
		async batch(statements) {
			state.batchCalls.push(statements.map((statement) => statement.sql));
			// Atomic like a transaction: a failed statement undoes the ledger insert.
			const before = [...ledger];
			try {
				for (const statement of statements) await statement.run();
			} catch (error) {
				ledger.clear();
				for (const row of before) ledger.add(row);
				throw error;
			}
			return [];
		},
	};
}

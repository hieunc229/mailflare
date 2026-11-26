import { DurableObject } from "cloudflare:workers";
import bundle from "@/lib/migrations/bundle.json";

type Mode = "array" | "object";
interface QueryOutcome {
	rows: unknown[];
	affectedRows: number;
	insertId?: number;
}

const WRITES = /^\s*(insert|update|delete|replace)\b/i;

/**
 * One tenant's whole database: a SQLite file owned by this Durable Object. The Worker reaches it through
 * `query` (see executor.ts) and Mailflare sees an ordinary `env.DB`. On every wake the object applies the
 * migrations of the Mailflare release it is running, each in its own transaction, so deploying a new
 * release upgrades a tenant the first time it is opened.
 */
export class TenantDb extends DurableObject<CloudflareEnv> {
	constructor(ctx: DurableObjectState, env: CloudflareEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private migrate() {
		const { sql } = this.ctx.storage;
		sql.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
		const applied = new Set(sql.exec<{ name: string }>("SELECT name FROM d1_migrations").toArray().map((row) => row.name));
		for (const migration of bundle.migrations) {
			if (applied.has(migration.name)) continue;
			this.ctx.storage.transactionSync(() => {
				sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", migration.name);
				for (const statement of migration.statements) sql.exec(statement);
			});
		}
	}

	/** Run one statement. RPC entry point used by the Worker-side executor. */
	query(text: string, params: unknown[], mode: Mode): QueryOutcome {
		const { sql } = this.ctx.storage;
		const cursor = sql.exec(text, ...params.map(bindable));
		if (cursor.columnNames.length === 0) {
			cursor.toArray();
			const { changes, id } = sql.exec<{ changes: number; id: number }>("SELECT changes() AS changes, last_insert_rowid() AS id").one();
			return { rows: [], affectedRows: changes, insertId: id };
		}
		const rows = mode === "array" ? [...cursor.raw()] : cursor.toArray();
		// INSERT/UPDATE/DELETE ... RETURNING reports its rows as the number of changes.
		return { rows, affectedRows: WRITES.test(text) ? rows.length : 0 };
	}

	/** Remove everything this tenant stored. Used when the workspace is deleted. */
	async destroy() {
		await this.ctx.storage.deleteAll();
	}
}

function bindable(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof Date) return Math.floor(value.getTime() / 1000);
	if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
	return value;
}

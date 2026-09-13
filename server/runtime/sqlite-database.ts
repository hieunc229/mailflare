import Database from "better-sqlite3";

/**
 * The D1 database API over a local SQLite file. Drizzle's D1 driver and the
 * app's raw `env.DB.prepare(...)` calls both go through this, so the schema,
 * migrations, FTS index and triggers are identical to a Cloudflare deploy.
 */
type Row = Record<string, unknown>;

function meta(info?: Database.RunResult) {
	return {
		duration: 0,
		size_after: 0,
		rows_read: 0,
		rows_written: info?.changes ?? 0,
		last_row_id: Number(info?.lastInsertRowid ?? 0),
		changed_db: (info?.changes ?? 0) > 0,
		changes: info?.changes ?? 0,
	};
}

function normalizeParam(value: unknown): unknown {
	if (value instanceof Date) return Math.floor(value.getTime() / 1000);
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return value;
}

class SqlitePreparedStatement {
	constructor(
		private readonly db: Database.Database,
		private readonly sql: string,
		private readonly params: unknown[] = [],
	) {}

	bind(...values: unknown[]) {
		return new SqlitePreparedStatement(this.db, this.sql, values.map(normalizeParam));
	}

	private statement() {
		return this.db.prepare(this.sql);
	}

	private isRead(): boolean {
		return /^\s*(select|with|pragma|explain)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
	}

	async first<T = Row>(column?: string): Promise<T | null> {
		const row = this.statement().get(...this.params) as Row | undefined;
		if (!row) return null;
		return (column ? row[column] : row) as T;
	}

	async run<T = Row>() {
		if (this.isRead()) {
			const results = this.statement().all(...this.params) as T[];
			return { results, success: true as const, meta: meta() };
		}
		const info = this.statement().run(...this.params);
		return { results: [] as T[], success: true as const, meta: meta(info) };
	}

	async all<T = Row>() {
		return this.run<T>();
	}

	async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
		if (!this.isRead()) {
			this.statement().run(...this.params);
			return [];
		}
		const statement = this.statement();
		const rows = statement.raw(true).all(...this.params) as T[];
		if (options?.columnNames) {
			const names = statement.columns().map((column) => column.name) as unknown as T;
			return [names, ...rows];
		}
		return rows;
	}
}

export class SqliteDatabase {
	readonly db: Database.Database;

	constructor(filename: string) {
		this.db = new Database(filename);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("busy_timeout = 5000");
	}

	prepare(sql: string) {
		return new SqlitePreparedStatement(this.db, sql);
	}

	/** Run statements atomically, like D1's batch. */
	async batch<T = Row>(statements: SqlitePreparedStatement[]) {
		const results: Awaited<ReturnType<SqlitePreparedStatement["all"]>>[] = [];
		this.db.exec("BEGIN");
		try {
			for (const statement of statements) results.push(await statement.all<T>());
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return results;
	}

	async exec(sql: string) {
		this.db.exec(sql);
		return { count: 0, duration: 0 };
	}

	async dump(): Promise<ArrayBuffer> {
		const buffer = this.db.serialize();
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
	}

	withSession() {
		return this;
	}
}

export function openSqliteDatabase(filename: string): D1Database {
	return new SqliteDatabase(filename) as unknown as D1Database;
}

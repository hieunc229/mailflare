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
		private readonly db: Database.Database & { __statements?: Map<string, Database.Statement> },
		private readonly sql: string,
		private readonly params: unknown[] = [],
		/**
		 * The connection's lock, for a statement prepared outside a transaction: it waits until any transaction
		 * in progress has committed or rolled back. A statement prepared by `SqliteTransaction` passes null —
		 * it already runs inside that transaction — and names its owner in `scope`.
		 */
		private readonly gate: (() => Promise<() => void>) | null = null,
		/** The transaction that prepared this statement, or null for an ordinary one. */
		readonly scope: SqliteTransaction | null = null,
	) {}

	bind(...values: unknown[]) {
		return new SqlitePreparedStatement(this.db, this.sql, values.map(normalizeParam), this.gate, this.scope);
	}

	/** @internal The same statement without the connection gate, for a caller that already holds it. */
	withoutGate() {
		return new SqlitePreparedStatement(this.db, this.sql, this.params, null, null);
	}

	/** Runs `work` while holding the connection, or directly when this statement's scope already holds it. */
	private async gated<T>(work: () => T | Promise<T>): Promise<T> {
		if (!this.gate) return work();
		const release = await this.gate();
		try {
			return await work();
		} finally {
			release();
		}
	}

	private statement() {
		const cache = (this.db as Database.Database & { __statements?: Map<string, Database.Statement> }).__statements
			?? ((this.db as Database.Database & { __statements?: Map<string, Database.Statement> }).__statements = new Map());
		let statement = cache.get(this.sql);
		if (!statement) {
			statement = this.db.prepare(this.sql);
			cache.set(this.sql, statement);
		}
		return statement;
	}

	private isRead(): boolean {
		return /^\s*(select|with|pragma|explain)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
	}

	async first<T = Row>(column?: string): Promise<T | null> {
		const row = await this.gated(() => this.statement().raw(false).get(...this.params) as Row | undefined);
		if (!row) return null;
		return (column ? row[column] : row) as T;
	}

	async run<T = Row>() {
		if (this.isRead()) {
			const results = await this.gated(() => this.statement().raw(false).all(...this.params) as T[]);
			return { results, success: true as const, meta: meta() };
		}
		const info = await this.gated(() => this.statement().run(...this.params));
		return { results: [] as T[], success: true as const, meta: meta(info) };
	}

	async all<T = Row>() {
		return this.run<T>();
	}

	async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
		if (!this.isRead()) {
			await this.gated(() => this.statement().run(...this.params));
			return [];
		}
		return this.gated(() => {
			const statement = this.statement();
			const rows = statement.raw(true).all(...this.params) as T[];
			if (options?.columnNames) {
				const names = statement.columns().map((column) => column.name) as unknown as T;
				return [names, ...rows];
			}
			return rows;
		});
	}
}

/** The view a `transaction` callback receives: it owns the connection for as long as the callback runs. */
export class SqliteTransaction {
	constructor(private readonly database: SqliteDatabase) {}

	get dialect() {
		return "sqlite" as const;
	}

	/** Statements prepared here run inside the transaction; they must not wait for its lock. */
	prepare(sql: string) {
		return new SqlitePreparedStatement(this.database.raw, sql, [], null, this);
	}

	async batch<T = Row>(statements: SqlitePreparedStatement[]) {
		// A statement prepared outside this transaction would wait for the connection this callback is holding:
		// say so instead of hanging until something times out.
		for (const statement of statements) {
			if (statement.scope !== this) throw new Error("A statement prepared outside this transaction cannot run in it; prepare it on the transaction scope.");
		}
		const results: Awaited<ReturnType<SqlitePreparedStatement["all"]>>[] = [];
		for (const statement of statements) results.push(await statement.withoutGate().all<T>());
		return results;
	}

	async exec(sql: string) {
		this.database.raw.exec(sql);
		return { count: 0, duration: 0 };
	}

	/** Already inside the transaction: a nested call joins this connection instead of starting another. */
	transaction<T>(work: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
		return work(this);
	}

	/** Nothing to discard: the runtime owns the single connection, and the transaction ends with the callback. */
	async discard(): Promise<void> {}
}

export class SqliteDatabase {
	readonly db: Database.Database;
	/** Tail of the queue that serialises work on this single connection. */
	private lock: Promise<void> = Promise.resolve();

	constructor(filename: string) {
		this.db = new Database(filename) as Database.Database & { __statements?: Map<string, Database.Statement> };
		(this.db as Database.Database & { __statements?: Map<string, Database.Statement> }).__statements = new Map();
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("busy_timeout = 5000");
		// Stock defaults are correct for the smallest installs, so tuning is
		// opt-in only — no mailbox-size assumptions baked into the tree.
		// Larger self-host databases can raise the page cache and mmap window
		// via env (mmap serves reads straight from the OS page cache), keep
		// sort materialization in memory, or drop synchronous to NORMAL —
		// under WAL that cannot corrupt the database, but a power loss can
		// still roll back the last committed transactions.
		const cacheKb = Number(process.env.SQLITE_CACHE_KB ?? 0);
		const mmapBytes = Number(process.env.SQLITE_MMAP_BYTES ?? 0);
		const synchronous = (process.env.SQLITE_SYNCHRONOUS ?? "").toUpperCase();
		if (Number.isFinite(cacheKb) && cacheKb > 0) this.db.pragma(`cache_size = -${Math.floor(cacheKb)}`);
		if (Number.isFinite(mmapBytes) && mmapBytes > 0) this.db.pragma(`mmap_size = ${Math.floor(mmapBytes)}`);
		if ((process.env.SQLITE_TEMP_STORE ?? "").toLowerCase() === "memory") this.db.pragma("temp_store = memory");
		if (synchronous === "NORMAL" || synchronous === "OFF") this.db.pragma(`synchronous = ${synchronous}`);
	}

	/** The raw better-sqlite3 handle; used by the transaction scope, which already owns the connection. */
	get raw() {
		return this.db as Database.Database & { __statements?: Map<string, Database.Statement> };
	}

	/**
	 * Runs `work` with exclusive use of the connection. Everything else that wants the connection — including a
	 * statement prepared before the transaction started — waits here until it is released, so a caller in the
	 * middle of a transaction can never have an unrelated reader see its uncommitted rows or an unrelated writer
	 * join and be rolled back with it. They run after the commit or rollback, not inside it.
	 */
	private async exclusive<T>(work: () => Promise<T>): Promise<T> {
		const previous = this.lock;
		let release!: () => void;
		this.lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			release();
		}
	}

	/** Acquires the connection for one statement; the returned function releases it. */
	private gate = () => this.exclusive(async () => () => undefined);

	supportsTransaction() {
		return true;
	}

	prepare(sql: string) {
		return new SqlitePreparedStatement(this.raw, sql, [], this.gate);
	}

	/**
	 * Runs `work` inside one transaction on the connection, which it holds until the callback settles. The
	 * callback's `SqliteTransaction` is the only thing that can reach the connection meanwhile; other callers
	 * wait outside. The restore uses this so a failure part-way through puts back the rows it already deleted.
	 */
	async transaction<T>(work: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
		return this.exclusive(async () => {
			this.db.exec("BEGIN");
			try {
				const result = await work(new SqliteTransaction(this));
				this.db.exec("COMMIT");
				return result;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		});
	}

	/** Run statements atomically, like D1's batch. */
	async batch<T = Row>(statements: SqlitePreparedStatement[]) {
		return this.exclusive(async () => {
			const results: Awaited<ReturnType<SqlitePreparedStatement["all"]>>[] = [];
			this.db.exec("BEGIN");
			try {
				// The connection is already held here, so the statements must not wait for their own gate.
				for (const statement of statements) results.push(await statement.withoutGate().all<T>());
				this.db.exec("COMMIT");
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
			return results;
		});
	}

	async exec(sql: string) {
		return this.exclusive(async () => {
			this.db.exec(sql);
			return { count: 0, duration: 0 };
		});
	}

	async dump(): Promise<ArrayBuffer> {
		return this.exclusive(async () => {
			const buffer = this.db.serialize();
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
		});
	}

	withSession(_constraintOrBookmark?: string) {
		return this;
	}

	getBookmark(): string | null {
		return null;
	}
}

export function openSqliteDatabase(filename: string): D1Database {
	return new SqliteDatabase(filename) as unknown as D1Database;
}

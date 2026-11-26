import type { DatabaseDialect } from "./dialect";
import { normalizeParam, numberPlaceholders, type SqlExecutor } from "./drivers/types";

/**
 * A `D1Database` over any SqlExecutor, for the raw `env.DB.prepare(...)` call sites. SQL is written
 * with `?` placeholders as D1 expects; PostgreSQL gets them numbered here.
 */
type Row = Record<string, unknown>;

function meta(affectedRows: number, insertId?: number) {
	return { duration: 0, size_after: 0, rows_read: 0, rows_written: affectedRows, last_row_id: insertId ?? 0, changed_db: affectedRows > 0, changes: affectedRows };
}

export class CompatStatement {
	constructor(
		readonly db: CompatDatabase,
		readonly sql: string,
		readonly params: unknown[] = [],
	) {}

	bind(...values: unknown[]) {
		return new CompatStatement(this.db, this.sql, values.map(normalizeParam));
	}

	/** Statements without parameters (migrations) are sent untouched, so a `?` inside a function body survives. */
	private text() {
		return this.db.dialect === "postgres" && this.params.length > 0 ? numberPlaceholders(this.sql) : this.sql;
	}

	/** @internal */
	async execute(executor: SqlExecutor) {
		return executor.query(this.text(), this.params, "object");
	}

	async run<T = Row>() {
		const result = await this.execute(this.db.executor());
		return { results: result.rows as T[], success: true as const, meta: meta(result.affectedRows, result.insertId) };
	}

	async all<T = Row>() {
		return this.run<T>();
	}

	async first<T = Row>(column?: string): Promise<T | null> {
		const result = await this.execute(this.db.executor());
		const row = result.rows[0] as Row | undefined;
		if (!row) return null;
		return (column ? row[column] : row) as T;
	}

	async raw<T = unknown[]>(): Promise<T[]> {
		return (await this.db.executor().query(this.text(), this.params, "array")).rows as T[];
	}
}

export class CompatDatabase {
	/** Set while a transaction runs, so every statement made through this adapter uses its connection. */
	private transactionExecutor: SqlExecutor | null = null;

	constructor(
		readonly dialect: DatabaseDialect,
		private readonly base: SqlExecutor,
		private readonly active: () => SqlExecutor | null = () => null,
	) {}

	executor() {
		return this.transactionExecutor ?? this.active() ?? this.base;
	}

	/**
	 * Runs `work` inside one transaction on a driver that can hold one. Every statement made through this
	 * adapter while it runs — `prepare`, `exec` and nested `batch` calls — uses that connection, so a failure
	 * anywhere rolls the whole block back. The backup restore uses it; D1 has no interactive transaction, so
	 * there this is a plain call.
	 */
	async transaction<T>(work: () => Promise<T>): Promise<T> {
		if (!this.base.transaction || this.transactionExecutor) return work();
		return this.base.transaction(async (executor) => {
			this.transactionExecutor = executor;
			try {
				return await work();
			} finally {
				this.transactionExecutor = null;
			}
		});
	}

	prepare(sql: string) {
		return new CompatStatement(this, sql);
	}

	async batch<T = Row>(statements: CompatStatement[]) {
		const run = async (executor: SqlExecutor) => {
			const results: Array<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> = [];
			for (const statement of statements) {
				const result = await statement.execute(executor);
				results.push({ results: result.rows as T[], success: true as const, meta: meta(result.affectedRows, result.insertId) });
			}
			return results;
		};
		// Inside `transaction` the statements join it, so a later failure rolls this batch back too.
		if (this.transactionExecutor) return run(this.transactionExecutor);
		return this.base.transaction ? this.base.transaction(run) : run(this.base);
	}

	async exec(sql: string) {
		// Through the executors so a statement issued inside `transaction` stays on its connection.
		const result = await this.executor().query(sql, [], "object");
		return { count: 1, duration: 0, rows: result.rows };
	}

	async dump(): Promise<ArrayBuffer> {
		throw new Error("dump() is not available on external databases.");
	}
}

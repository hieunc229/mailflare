import type { DatabaseDialect } from "./dialect";
import { normalizeParam, numberPlaceholders, type SqlExecutor } from "./drivers/types";

/**
 * A `D1Database` over any SqlExecutor, for the raw `env.DB.prepare(...)` call sites. SQL is written
 * with `?` placeholders as D1 expects; PostgreSQL gets them numbered here.
 *
 * Transactions are owned explicitly: `transaction(work)` checks out a connection, hands the callback a
 * `CompatTransaction` bound to it, and commits or rolls back. Nothing else on this adapter can join that
 * transaction — an ordinary caller keeps using the pool, so it neither sees uncommitted rows nor has its own
 * writes rolled back with the restore's.
 */
type Row = Record<string, unknown>;

function meta(affectedRows: number, insertId?: number) {
	return { duration: 0, size_after: 0, rows_read: 0, rows_written: affectedRows, last_row_id: insertId ?? 0, changed_db: affectedRows > 0, changes: affectedRows };
}

/** What a statement needs from whatever it was prepared on: the dialect and the connection to run on. */
interface StatementHost {
	readonly dialect: DatabaseDialect;
	executor(): SqlExecutor;
}

export class CompatStatement {
	constructor(
		readonly db: StatementHost,
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

async function runStatements<T>(statements: CompatStatement[], executor: SqlExecutor) {
	const results: Array<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> = [];
	for (const statement of statements) {
		const result = await statement.execute(executor);
		results.push({ results: result.rows as T[], success: true as const, meta: meta(result.affectedRows, result.insertId) });
	}
	return results;
}

/**
 * The view a `transaction` callback receives: every statement it prepares runs on the connection that
 * transaction checked out, and nothing else can reach that connection.
 */
export class CompatTransaction implements StatementHost {
	constructor(
		readonly dialect: DatabaseDialect,
		private readonly connection: SqlExecutor,
	) {}

	executor() {
		return this.connection;
	}

	/**
	 * Throws the connection away instead of returning it to the pool. Used when a session setting that was
	 * changed for the transaction cannot be put back, so the pool never hands out a connection in that state.
	 */
	async discard(): Promise<void> {
		await this.connection.destroy?.();
	}

	prepare(sql: string) {
		return new CompatStatement(this, sql);
	}

	batch<T = Row>(statements: CompatStatement[]) {
		// A statement prepared on the adapter would run here on the transaction's connection, silently joining it.
		// Reject it instead: the caller has to prepare through this view.
		for (const statement of statements) {
			if (statement.db !== this) throw new Error("A statement prepared outside this transaction cannot run in it; prepare it on the transaction view.");
		}
		return runStatements<T>(statements, this.connection);
	}

	async exec(sql: string) {
		const result = await this.connection.query(sql, [], "object");
		return { count: 1, duration: 0, rows: result.rows };
	}

	/** Already inside the transaction: a nested call joins this connection instead of starting another. */
	transaction<T>(work: (tx: CompatTransaction) => Promise<T>): Promise<T> {
		return work(this);
	}
}

export class CompatDatabase implements StatementHost {
	constructor(
		readonly dialect: DatabaseDialect,
		private readonly base: SqlExecutor,
		private readonly active: () => SqlExecutor | null = () => null,
	) {}

	/** The driver's own declaration; never inferred from whether a `transaction` method happens to exist. */
	supportsTransaction(): boolean {
		return this.base.transactions === "atomic" && typeof this.base.transaction === "function";
	}

	executor() {
		return this.active() ?? this.base;
	}

	/**
	 * Runs `work` on a connection checked out for it. Only the `CompatTransaction` passed to the callback uses
	 * that connection: an ordinary caller on this adapter keeps using the pool, so it neither reads the
	 * uncommitted rows nor has its own statements rolled back with this transaction. Throws when the driver
	 * cannot hold a transaction open, so a caller that depends on atomicity can tell.
	 */
	async transaction<T>(work: (tx: CompatTransaction) => Promise<T>): Promise<T> {
		if (!this.supportsTransaction()) throw new Error("This database driver cannot hold a transaction open.");
		return this.base.transaction!((connection) => work(new CompatTransaction(this.dialect, connection)));
	}

	prepare(sql: string) {
		return new CompatStatement(this, sql);
	}

	/**
	 * A batch is atomic when the driver can hold a transaction: it gets a connection of its own. On a driver that
	 * declared none (Neon, D1) the statements run one after another, as they did before transactions existed.
	 */
	async batch<T = Row>(statements: CompatStatement[]) {
		if (!this.supportsTransaction()) return runStatements<T>(statements, this.base);
		return this.base.transaction!((connection) => runStatements<T>(statements, connection));
	}

	async exec(sql: string) {
		const result = await this.executor().query(sql, [], "object");
		return { count: 1, duration: 0, rows: result.rows };
	}

	async dump(): Promise<ArrayBuffer> {
		throw new Error("dump() is not available on external databases.");
	}
}

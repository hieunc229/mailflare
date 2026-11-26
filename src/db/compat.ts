import { and, eq, getTableColumns, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DatabaseDialect } from "./dialect";
import type { RowMode, SqlExecutor } from "./drivers/types";

/**
 * The app is written against drizzle's SQLite API: `db.run/all/get/batch`, `onConflictDo*` and
 * `returning`. This wraps a PostgreSQL or MySQL drizzle instance so those calls keep working:
 *
 * - `run`, `all`, `get` run raw `sql` through the executor (PostgreSQL and MySQL have no such methods).
 * - `batch` runs the statements in order inside one transaction when the driver can hold one.
 * - MySQL has no `ON CONFLICT` or `RETURNING`; insert/update/delete are shimmed to ON DUPLICATE KEY
 *   UPDATE and a select-by-primary-key after the write.
 */
export interface ExecutorContext {
	base: SqlExecutor;
	/** Set while a batch runs so every statement lands on the batch's connection. */
	tx: SqlExecutor | null;
}

export const currentExecutor = (ctx: ExecutorContext) => ctx.tx ?? ctx.base;

interface DrizzleLike {
	dialect: { sqlToQuery(query: SQL): { sql: string; params: unknown[] } };
	[key: string]: unknown;
}

export interface RunResult {
	success: true;
	results: unknown[];
	meta: { changes: number; last_row_id: number; rows_written: number; changed_db: boolean };
}

async function runRaw(db: DrizzleLike, ctx: ExecutorContext, query: SQL, mode: RowMode) {
	const { sql: text, params } = db.dialect.sqlToQuery(query);
	return currentExecutor(ctx).query(text, params, mode);
}

export function wrapDatabase<T extends object>(db: T, dialect: DatabaseDialect, ctx: ExecutorContext): T {
	const raw = db as unknown as DrizzleLike;

	const batch = async (queries: PromiseLike<unknown>[]) => {
		const runAll = async () => {
			const results: unknown[] = [];
			for (const query of queries) results.push(await query);
			return results;
		};
		const { base } = ctx;
		if (!base.transaction || ctx.tx) return runAll();
		return base.transaction(async (tx) => {
			ctx.tx = tx;
			try {
				return await runAll();
			} finally {
				ctx.tx = null;
			}
		});
	};

	const overrides: Record<string, unknown> = {
		async all(query: SQL) {
			return (await runRaw(raw, ctx, query, "object")).rows;
		},
		async get(query: SQL) {
			return (await runRaw(raw, ctx, query, "object")).rows[0];
		},
		async values(query: SQL) {
			return (await runRaw(raw, ctx, query, "array")).rows;
		},
		async run(query: SQL): Promise<RunResult> {
			const result = await runRaw(raw, ctx, query, "object");
			return {
				success: true,
				results: result.rows,
				meta: { changes: result.affectedRows, last_row_id: result.insertId ?? 0, rows_written: result.affectedRows, changed_db: result.affectedRows > 0 },
			};
		},
		batch,
	};

	if (dialect === "mysql") {
		overrides.insert = (table: AnyTable) => new MysqlInsertShim(raw as unknown as MysqlDb, table);
		overrides.update = (table: AnyTable) => new MysqlUpdateShim(raw as unknown as MysqlDb, table);
		overrides.delete = (table: AnyTable) => new MysqlDeleteShim(raw as unknown as MysqlDb, table);
	}

	return new Proxy(db, {
		get(target, property) {
			if (typeof property === "string" && property in overrides) return overrides[property];
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

// ---- MySQL shims ----

type AnyTable = Parameters<typeof getTableColumns>[0];
type Row = Record<string, unknown>;
type MysqlDb = DrizzleLike & {
	insert(table: AnyTable): { values(values: unknown): { onDuplicateKeyUpdate(config: { set: Row }): PromiseLike<unknown> } & PromiseLike<unknown> };
	update(table: AnyTable): { set(values: unknown): { where(condition?: SQL): PromiseLike<unknown> } & PromiseLike<unknown> };
	delete(table: AnyTable): { where(condition?: SQL): PromiseLike<unknown> } & PromiseLike<unknown>;
	select(fields?: unknown): { from(table: AnyTable): { where(condition?: SQL): PromiseLike<Row[]> } & PromiseLike<Row[]> };
};

function affectedRows(result: unknown): number {
	const header = Array.isArray(result) ? result[0] : result;
	return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

function insertId(result: unknown): number {
	const header = Array.isArray(result) ? result[0] : result;
	return Number((header as { insertId?: number } | undefined)?.insertId ?? 0);
}

function primaryKey(table: AnyTable) {
	const columns = Object.values(getTableColumns(table)) as Array<{ primary: boolean; name: string; autoIncrement?: boolean }>;
	const key = columns.find((column) => column.primary);
	if (!key) throw new Error("Emulating RETURNING on MySQL needs a single-column primary key.");
	const entry = Object.entries(getTableColumns(table)).find(([, column]) => column === (key as unknown));
	return { column: key as never, property: entry?.[0] ?? "id", autoIncrement: !!key.autoIncrement };
}

async function selectByKeys(db: MysqlDb, table: AnyTable, fields: unknown, keys: unknown[]): Promise<Row[]> {
	if (keys.length === 0) return [];
	const { column } = primaryKey(table);
	const query = fields ? db.select(fields) : db.select();
	return query.from(table).where(inArray(column, keys as never));
}

class MysqlInsertShim implements PromiseLike<unknown> {
	private rows: Row[] = [];
	private conflict: { set?: Row; target?: unknown } | null = null;
	private returningFields: unknown;
	private wantsReturning = false;

	constructor(
		private readonly db: MysqlDb,
		private readonly table: AnyTable,
	) {}

	values(values: Row | Row[]) {
		this.rows = Array.isArray(values) ? values : [values];
		return this;
	}

	onConflictDoNothing() {
		this.conflict = {};
		return this;
	}

	onConflictDoUpdate(config: { set: Row; target?: unknown }) {
		this.conflict = { set: config.set, target: config.target };
		return this;
	}

	returning(fields?: unknown) {
		this.wantsReturning = true;
		this.returningFields = fields;
		return this;
	}

	private async execute() {
		const statement = this.db.insert(this.table).values(this.rows.length === 1 ? this.rows[0] : this.rows);
		const key = this.wantsReturning ? primaryKey(this.table) : null;
		// ON DUPLICATE KEY UPDATE reports a rewritten row and a no-op the same way, so which keys already
		// existed is read first; only the others can have been inserted.
		const existing = key && this.conflict && !this.conflict.set ? new Set((await selectByKeys(this.db, this.table, { key: key.column }, this.keysOf(key, null))).map((row) => row.key)) : new Set<unknown>();
		let result: unknown;
		if (this.conflict) {
			// Assigning a column to itself is the "do nothing" form of ON DUPLICATE KEY UPDATE.
			const [property, column] = Object.entries(getTableColumns(this.table))[0];
			result = await statement.onDuplicateKeyUpdate({ set: this.conflict.set ?? { [property]: sql`${column}` } });
		} else {
			result = await statement;
		}
		if (!key) return result;
		// An update through a unique column other than the key keeps the existing row's key, not the new one.
		const byTarget = this.conflict?.set && this.targetCondition(key);
		if (byTarget) return (this.returningFields ? this.db.select(this.returningFields) : this.db.select()).from(this.table).where(byTarget);
		const keys = this.keysOf(key, result).filter((value) => !existing.has(value));
		return selectByKeys(this.db, this.table, this.returningFields, keys);
	}

	/** Matches the written rows by the conflict target, or null when the target is the primary key (or absent). */
	private targetCondition(key: ReturnType<typeof primaryKey>): SQL | null {
		const target = this.conflict?.target;
		const targets = (Array.isArray(target) ? target : target ? [target] : []) as unknown[];
		if (targets.length === 0 || (targets.length === 1 && targets[0] === key.column)) return null;
		const properties = targets.map((column) => Object.entries(getTableColumns(this.table)).find(([, candidate]) => candidate === column)?.[0]);
		if (properties.some((property) => !property)) return null;
		return or(...this.rows.map((row) => and(...targets.map((column, i) => eq(column as never, row[properties[i]!])))))!;
	}

	private keysOf(key: ReturnType<typeof primaryKey>, result: unknown): unknown[] {
		if (key.autoIncrement && result) return this.rows.map((_, i) => insertId(result) + i);
		return this.rows.map((row) => row[key.property]).filter((value) => value !== undefined);
	}

	then<R1 = unknown, R2 = never>(onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null) {
		return this.execute().then(onfulfilled, onrejected);
	}
}

class MysqlUpdateShim implements PromiseLike<unknown> {
	private values: Row = {};
	private condition?: SQL;
	private returningFields: unknown;
	private wantsReturning = false;

	constructor(
		private readonly db: MysqlDb,
		private readonly table: AnyTable,
	) {}

	set(values: Row) {
		this.values = values;
		return this;
	}

	where(condition?: SQL) {
		this.condition = condition;
		return this;
	}

	returning(fields?: unknown) {
		this.wantsReturning = true;
		this.returningFields = fields;
		return this;
	}

	private async execute() {
		const { column } = primaryKey(this.table);
		// Rows are identified before the write, because the write may change the columns the condition reads.
		const before = this.wantsReturning ? await this.db.select({ key: column }).from(this.table).where(this.condition) : [];
		const result = await this.db.update(this.table).set(this.values).where(this.condition);
		if (!this.wantsReturning) return result;
		// A claim (`UPDATE ... WHERE status = 'pending'`) loses the race when the write matched nothing.
		if (affectedRows(result) === 0) return [];
		return selectByKeys(this.db, this.table, this.returningFields, before.map((row) => row.key));
	}

	then<R1 = unknown, R2 = never>(onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null) {
		return this.execute().then(onfulfilled, onrejected);
	}
}

class MysqlDeleteShim implements PromiseLike<unknown> {
	private condition?: SQL;
	private returningFields: unknown;
	private wantsReturning = false;

	constructor(
		private readonly db: MysqlDb,
		private readonly table: AnyTable,
	) {}

	where(condition?: SQL) {
		this.condition = condition;
		return this;
	}

	returning(fields?: unknown) {
		this.wantsReturning = true;
		this.returningFields = fields;
		return this;
	}

	private async execute() {
		if (!this.wantsReturning) return this.db.delete(this.table).where(this.condition);
		const query = this.returningFields ? this.db.select(this.returningFields) : this.db.select();
		const before = await query.from(this.table).where(this.condition);
		const result = await this.db.delete(this.table).where(this.condition);
		return affectedRows(result) === 0 ? [] : before;
	}

	then<R1 = unknown, R2 = never>(onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null) {
		return this.execute().then(onfulfilled, onrejected);
	}
}


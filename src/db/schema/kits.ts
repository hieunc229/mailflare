import { sql, type SQL } from "drizzle-orm";
import * as sqlite from "drizzle-orm/sqlite-core";
import * as pg from "drizzle-orm/pg-core";
import * as mysql from "drizzle-orm/mysql-core";
import { schemaDialect, type DatabaseDialect } from "../dialect";

/**
 * The column and table constructors the schema is written against. The schema file is written once in
 * terms of this kit; the kit for the active dialect supplies the real drizzle builders.
 *
 * Representation is kept identical across dialects wherever raw SQL touches a column: timestamps are
 * whole seconds in a bigint, plain integers are bigint, booleans are native booleans (tinyint on
 * MySQL). Only SQLite typings are exposed to the rest of the app; the other kits are cast to the same
 * shape, which is safe because query building is dialect-agnostic for everything the app uses.
 */
const sqliteKit = {
	table: sqlite.sqliteTable,
	text: sqlite.text,
	integer: (name: string) => sqlite.integer(name),
	bool: (name: string) => sqlite.integer(name, { mode: "boolean" }),
	timestamp: (name: string) => sqlite.integer(name, { mode: "timestamp" }),
	autoId: (name: string) => sqlite.integer(name).primaryKey({ autoIncrement: true }),
	index: sqlite.index,
	uniqueIndex: sqlite.uniqueIndex,
	desc: (column: unknown): SQL | never => sql`${column} desc` as never,
	nowSeconds: sql`(unixepoch())` as SQL,
};

export type SchemaKit = typeof sqliteKit;

// ---- PostgreSQL ----

const pgTimestamp = pg.customType<{ data: Date; driverData: string | number }>({
	dataType: () => "bigint",
	fromDriver: (value) => new Date(Number(value) * 1000),
	toDriver: (value) => Math.floor(value.getTime() / 1000),
});

const pgKit = {
	table: pg.pgTable,
	text: (name: string, config?: { enum: readonly [string, ...string[]] }) => pg.text(name, config as never),
	integer: (name: string) => pg.bigint(name, { mode: "number" }),
	bool: (name: string) => pg.boolean(name),
	timestamp: (name: string) => pgTimestamp(name),
	autoId: (name: string) => pg.bigserial(name, { mode: "number" }).primaryKey(),
	index: pg.index,
	uniqueIndex: pg.uniqueIndex,
	desc: (column: unknown) => sql`${column} desc`,
	nowSeconds: sql`(extract(epoch from now())::bigint)` as SQL,
};

// ---- MySQL / MariaDB / TiDB ----

const mysqlTimestamp = mysql.customType<{ data: Date; driverData: string | number }>({
	dataType: () => "bigint",
	fromDriver: (value) => new Date(Number(value) * 1000),
	toDriver: (value) => Math.floor(value.getTime() / 1000),
});

/**
 * MySQL cannot index TEXT, so a text column that is a key, unique, referenced or used in an index must be a
 * VARCHAR; every other text column stays LONGTEXT. Which is which is only known once the whole table
 * (including its index callback) is seen, so `text()` returns a recorder that `table()` resolves.
 */
const KEY_LENGTH = 191;
const LONG_KEYS: Record<string, number> = {
	provider_message_id: 512,
	thread_id: 512,
	thread_key: 512,
	raw_r2_key: 512,
	r2_key: 512,
	endpoint: 512,
	email: 320,
	recipient: 320,
	name: 255,
	hostname: 255,
};
/** InnoDB allows 3072 bytes per index; utf8mb4 is 4 bytes per character. */
const INDEX_BYTE_BUDGET = 3000;
const KEYED_METHODS = new Set(["unique", "primaryKey", "references"]);

class MysqlTextColumn {
	private readonly calls: Array<[string, unknown[]]> = [];
	keyed = false;

	constructor(
		private readonly name: string,
		private readonly config?: { enum: readonly [string, ...string[]] },
	) {
		return new Proxy(this, {
			get: (target, property, receiver) => {
				if (typeof property !== "string" || property in target) return Reflect.get(target, property, receiver);
				return (...args: unknown[]) => {
					target.calls.push([property, args]);
					if (KEYED_METHODS.has(property)) target.keyed = true;
					return receiver;
				};
			},
		});
	}

	materialize(keyed: boolean) {
		// The builder type changes with each chained call, so it is handled untyped here.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let builder: any;
		if (this.config) {
			builder = mysql.varchar(this.name, { length: 64, enum: this.config.enum as [string, ...string[]] });
		} else if (keyed) {
			builder = mysql.varchar(this.name, { length: LONG_KEYS[this.name] ?? KEY_LENGTH });
		} else {
			// MySQL rejects literal defaults on TEXT columns; an expression default `('x')` is allowed (8.0.13+, MariaDB).
			builder = mysql.longtext(this.name);
			const literal = builder.default.bind(builder);
			builder.default = (value: unknown) => (typeof value === "string" ? literal(sql.raw(`('${value.replace(/'/g, "''")}')`)) : literal(value));
		}
		for (const [method, args] of this.calls) builder = builder[method](...args);
		return builder;
	}
}

const mysqlText = (name: string, config?: { enum: readonly [string, ...string[]] }) => new MysqlTextColumn(name, config);

/** Columns an index callback touches; found by running it once against recording stand-ins. */
function indexedProperties(extra: ((columns: Record<string, unknown>) => unknown[]) | undefined): Set<string> {
	const touched = new Set<string>();
	if (!extra) return touched;
	extra(new Proxy({}, { get: (_, property) => (typeof property === "string" && touched.add(property), { __column: property }) }));
	return touched;
}

function mysqlTable(name: string, columns: Record<string, unknown>, extra?: (columns: Record<string, unknown>) => unknown[]) {
	const indexed = indexedProperties(extra);
	const built = Object.fromEntries(
		Object.entries(columns).map(([property, column]) => [property, column instanceof MysqlTextColumn ? column.materialize(column.keyed || indexed.has(property)) : column]),
	);
	return mysql.mysqlTable(name, built as never, extra as never);
}

function columnBytes(column: unknown): number {
	const value = column as { length?: number; getSQLType?: () => string };
	if (typeof value?.length === "number") return value.length * 4;
	return 8;
}

type MysqlIndexBuilder = ReturnType<typeof mysql.index>;

const isExpression = (column: unknown) => !!column && typeof column === "object" && "queryChunks" in (column as object);

/**
 * MySQL cannot index more than 3072 bytes, which the wide covering indexes on `messages` exceed with
 * utf8mb4 keys. Covering indexes are only an optimisation, so trailing columns are dropped to fit.
 * Expression key parts (`coalesce(thread_id, id)`) are dropped too: drizzle-kit cannot emit MySQL
 * functional index syntax.
 */
function fitColumns(columns: unknown[], keepAll: boolean): unknown[] {
	const parts = columns.filter((column) => !isExpression(column));
	if (keepAll) return parts;
	const kept: unknown[] = [];
	let used = 0;
	for (const part of parts) {
		const bytes = columnBytes(part);
		if (kept.length > 0 && used + bytes > INDEX_BYTE_BUDGET) break;
		kept.push(part);
		used += bytes;
	}
	return kept;
}

function mysqlIndex(name: string) {
	const builder = mysql.index(name);
	return {
		on: (...columns: unknown[]) => builder.on(...(fitColumns(columns, false) as Parameters<MysqlIndexBuilder["on"]>)),
	};
}

function mysqlUniqueIndex(name: string) {
	const builder = mysql.uniqueIndex(name);
	return {
		on: (...columns: unknown[]) => {
			const unique = builder.on(...(fitColumns(columns, true) as Parameters<typeof builder.on>));
			// MySQL has no partial indexes; a filtered unique index cannot be expressed, so it becomes a plain index.
			(unique as unknown as { where: (condition: unknown) => unknown }).where = () => mysql.index(name).on(...(fitColumns(columns, true) as Parameters<MysqlIndexBuilder["on"]>));
			return unique;
		},
	};
}

const mysqlKit = {
	table: mysqlTable,
	text: mysqlText,
	integer: (name: string) => mysql.bigint(name, { mode: "number" }),
	bool: (name: string) => mysql.boolean(name),
	timestamp: (name: string) => mysqlTimestamp(name),
	autoId: (name: string) => mysql.bigint(name, { mode: "number" }).primaryKey().autoincrement(),
	index: mysqlIndex,
	uniqueIndex: mysqlUniqueIndex,
	// Descending key parts are only a sort hint; MySQL builds the index ascending and scans it backwards.
	desc: (column: unknown) => column,
	nowSeconds: sql`(unix_timestamp())` as SQL,
};

export function kitFor(dialect: DatabaseDialect): SchemaKit {
	if (dialect === "postgres") return pgKit as unknown as SchemaKit;
	if (dialect === "mysql") return mysqlKit as unknown as SchemaKit;
	return sqliteKit;
}

export const kit: SchemaKit = kitFor(schemaDialect());

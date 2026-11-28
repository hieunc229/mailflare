import type { DatabaseDialect } from "../dialect";

export type RowMode = "array" | "object";

export interface QueryResult {
	/** Arrays of column values (what drizzle's proxy drivers expect) or objects keyed by column name. */
	rows: unknown[];
	affectedRows: number;
	insertId?: number;
}

/**
 * The only thing a database driver has to provide. Every supported driver is a few lines that turn
 * `(sql, params)` into rows; drizzle runs on top of this through its proxy drivers, and the same executor
 * backs the D1-compatible `env.DB` used by the raw-SQL call sites.
 */
export interface SqlExecutor {
	readonly dialect: DatabaseDialect;
	query(sql: string, params: unknown[], mode: RowMode): Promise<QueryResult>;
	/** Run `fn` atomically on one connection. Absent for HTTP drivers that cannot hold a transaction open. */
	transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
	close?(): Promise<void>;
}

export interface OpenOptions {
	url: string;
	authToken?: string;
	/** Node keeps pools open between requests; Workers cannot reuse sockets across requests. */
	shared: boolean;
}

/** `?` to `$1, $2, ...` outside string literals, quoted identifiers and comments. */
export function numberPlaceholders(sql: string): string {
	let out = "";
	let index = 0;
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "'" || ch === '"') {
			const end = sql.indexOf(ch, i + 1);
			let close = end;
			// Doubled quotes are escapes inside the literal.
			while (close !== -1 && sql[close + 1] === ch) close = sql.indexOf(ch, close + 2);
			const stop = close === -1 ? sql.length : close + 1;
			out += sql.slice(i, stop);
			i = stop;
		} else if (ch === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i);
			const stop = end === -1 ? sql.length : end;
			out += sql.slice(i, stop);
			i = stop;
		} else if (ch === "?") {
			out += `$${++index}`;
			i++;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/** Convert values the drivers do not all accept the same way. */
export function normalizeParam(value: unknown): unknown {
	if (value === undefined) return null;
	if (value instanceof Date) return Math.floor(value.getTime() / 1000);
	if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return value;
}

/** Lazily open a driver the first time it is needed so unused drivers are never imported. */
export function lazyExecutor(dialect: DatabaseDialect, open: () => Promise<SqlExecutor>): SqlExecutor {
	let pending: Promise<SqlExecutor> | undefined;
	const ready = () => (pending ??= open().catch((error) => {
		pending = undefined;
		throw error;
	}));
	return {
		dialect,
		query: async (sql, params, mode) => (await ready()).query(sql, params, mode),
		transaction: async (fn) => {
			const inner = await ready();
			if (!inner.transaction) return fn(inner);
			return inner.transaction(fn);
		},
		close: async () => {
			if (pending) await (await pending).close?.();
			pending = undefined;
		},
	};
}

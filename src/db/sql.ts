import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { schemaDialect } from "./dialect";

/**
 * SQL that differs between SQLite, PostgreSQL and MySQL, in one place. Everything else the app writes
 * (comparisons, `coalesce`, `case`, window functions, `exists`) is common to all three.
 */
const dialect = schemaDialect();

/**
 * `LIKE` that ignores case on every dialect: SQLite and MySQL already do, PostgreSQL needs ILIKE.
 * Always has `ESCAPE '!'` so a pattern built with `escapeLike` means the same on all three (SQLite has no
 * default escape character; PostgreSQL and MySQL default to a backslash).
 */
export function insensitiveLike(column: AnyColumn | SQL, pattern: string): SQL {
	const operator = dialect === "postgres" ? sql.raw("ilike") : sql.raw("like");
	return sql`${column} ${operator} ${pattern} escape ${sql.raw(`'${LIKE_ESCAPE}'`)}`;
}

/** Case-insensitive "contains `term`" match, with `%`, `_` and `!` in the term taken literally. */
export function containsLike(column: AnyColumn | SQL, term: string): SQL {
	return insensitiveLike(column, `%${escapeLike(term)}%`);
}

/** The value an `ON CONFLICT DO UPDATE` / `ON DUPLICATE KEY UPDATE` would have inserted. */
export function excluded(column: AnyColumn): SQL {
	const name = sql.identifier(column.name);
	return dialect === "mysql" ? sql`values(${name})` : sql`excluded.${name}`;
}

/** Scalar maximum of several values (SQLite's two-argument `max`). */
export function greatest(...values: Array<SQL | number>): SQL {
	const list = sql.join(values.map((value) => (typeof value === "number" ? sql.raw(String(value)) : value)), sql`, `);
	return dialect === "sqlite" ? sql`max(${list})` : sql`greatest(${list})`;
}

/** 1-based position of `needle` in `haystack`, 0 when absent. */
export function charIndex(haystack: AnyColumn | SQL, needle: string): SQL {
	return dialect === "postgres" ? sql`strpos(${haystack}, ${needle})` : sql`instr(${haystack}, ${needle})`;
}

/** String concatenation; `||` is logical OR on MySQL. String arguments are SQL literals, so pass constants only. */
export function concatText(...parts: Array<SQL | string>): SQL {
	const list = parts.map((part) => (typeof part === "string" ? sql.raw(`'${part.replace(/'/g, "''")}'`) : part));
	return dialect === "mysql" ? sql`concat(${sql.join(list, sql`, `)})` : sql.join(list, sql` || `);
}

/** Boolean literals for `WHERE`: PostgreSQL rejects a bare `0` or `1` there. */
export const matchNothing: SQL = sql`1 = 0`;
export const matchEverything: SQL = sql`1 = 1`;

/** `ESCAPE` character for `LIKE`: a backslash is an escape inside MySQL string literals, `!` is not. */
export const LIKE_ESCAPE = "!";
export const escapeLike = (value: string) => value.replace(/[!%_]/g, "!$&");

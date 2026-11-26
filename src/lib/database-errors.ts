/**
 * Whether any error in the chain matches: a driver error code (`code`/`errno`, as pg and
 * mysql2 set them, so wording and locale do not matter) or, failing that, a message matching
 * `pattern`. Drizzle wraps driver errors as "Failed query: …" and keeps the driver error on
 * `cause`, so checking only the outer error misses it. The patterns cover SQLite/D1,
 * PostgreSQL and MySQL wording.
 */
function errorChainMatches(error: unknown, pattern: RegExp, codes: readonly (string | number)[] = []): boolean {
	let current: unknown = error;
	const visited = new Set<unknown>();
	while (current && !visited.has(current)) {
		visited.add(current);
		if (typeof current === "object") {
			const { code, errno } = current as { code?: unknown; errno?: unknown };
			if (codes.some((c) => c === code || c === errno)) return true;
		}
		if (pattern.test(current instanceof Error ? current.message : String(current))) return true;
		if (typeof current !== "object" || !("cause" in current)) break;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** The table does not exist yet, for features whose migration may not be applied. */
export function isMissingTableError(error: unknown): boolean {
	return errorChainMatches(error, /no such table|relation "[^"]+" does not exist|table '[^']+' doesn't exist/i, ["42P01", 1146, "ER_NO_SUCH_TABLE"]);
}

/** A column added by a migration that may not be applied yet. */
export function isMissingColumnError(error: unknown): boolean {
	return errorChainMatches(error, /no such column|has no column named|column ("[^"]+"|[\w.]+) (of relation "[^"]+" )?does not exist|unknown column/i, ["42703", 1054, "ER_BAD_FIELD_ERROR"]);
}

/** The codes a driver uses for a duplicate key: PostgreSQL SQLSTATE, MySQL name and number, SQLite. */
const UNIQUE_KEY_CODES = new Set(["23505", "ER_DUP_ENTRY", "1062", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"]);

/** Every `code`/`errno` on the error chain, outermost first. */
function driverCodes(error: unknown): string[] {
	const codes: string[] = [];
	const visited = new Set<unknown>();
	let current: unknown = error;
	while (current && !visited.has(current)) {
		visited.add(current);
		if (typeof current === "object") {
			const { code, errno } = current as { code?: unknown; errno?: unknown };
			if (typeof code === "string" && code.length > 0) codes.push(code);
			if (typeof errno === "number") codes.push(String(errno));
		}
		if (typeof current !== "object" || !("cause" in current)) break;
		current = (current as { cause?: unknown }).cause;
	}
	return codes;
}

/**
 * A duplicate key. A driver code is authoritative and is checked before any wording: Drizzle's wrapper message
 * repeats the statement with its bound parameters, so a bound value that happens to read like a duplicate would
 * otherwise win over the driver's own verdict (and the reverse). Only an error chain with no code at all — D1
 * and some SQLite drivers — falls back to the message.
 */
export function isUniqueConstraintError(error: unknown): boolean {
	const codes = driverCodes(error);
	if (codes.length > 0) return codes.some((code) => UNIQUE_KEY_CODES.has(code));
	return errorChainMatches(error, /UNIQUE constraint failed|duplicate key value violates unique constraint|duplicate entry/i);
}

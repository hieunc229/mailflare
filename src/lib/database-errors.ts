/**
 * Whether any error in the chain has a message matching `pattern`. Drizzle
 * wraps driver errors as "Failed query: …" and keeps the driver message on
 * `cause`, so checking only the outer message misses it. The patterns cover
 * SQLite/D1, PostgreSQL and MySQL wording.
 */
function errorChainMatches(error: unknown, pattern: RegExp): boolean {
	let current: unknown = error;
	const visited = new Set<unknown>();
	while (current && !visited.has(current)) {
		visited.add(current);
		if (pattern.test(current instanceof Error ? current.message : String(current))) return true;
		if (typeof current !== "object" || !("cause" in current)) break;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** The table does not exist yet, for features whose migration may not be applied. */
export function isMissingTableError(error: unknown): boolean {
	return errorChainMatches(error, /no such table|relation "[^"]+" does not exist|table '[^']+' doesn't exist/i);
}

/** A column added by a migration that may not be applied yet. */
export function isMissingColumnError(error: unknown): boolean {
	return errorChainMatches(error, /no such column|has no column named|column "[^"]+" (of relation "[^"]+" )?does not exist|unknown column/i);
}

export function isUniqueConstraintError(error: unknown): boolean {
	return errorChainMatches(error, /UNIQUE constraint failed|duplicate key value violates unique constraint|duplicate entry/i);
}

/** Driver error codes (PostgreSQL SQLSTATE, MySQL errno) that mean "the transaction lost a race, run it again". */
const RETRYABLE_CODES = new Set(["40001", "40P01", "1213", "1205"]);

/**
 * A write that lost a race and is safe to run again from the start: a unique
 * violation, a PostgreSQL serialization failure (40001) or deadlock (40P01), a
 * MySQL deadlock (1213) or lock wait timeout (1205). The transaction rolled back,
 * so nothing it did is visible.
 */
export function isRetryableConflictError(error: unknown): boolean {
	if (isUniqueConstraintError(error) || errorChainMatches(error, /could not serialize access|deadlock detected|deadlock found when trying to get lock|lock wait timeout exceeded/i)) return true;
	let current: unknown = error;
	const visited = new Set<unknown>();
	while (current && typeof current === "object" && !visited.has(current)) {
		visited.add(current);
		const { code, errno } = current as { code?: unknown; errno?: unknown };
		if (RETRYABLE_CODES.has(String(code)) || RETRYABLE_CODES.has(String(errno))) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

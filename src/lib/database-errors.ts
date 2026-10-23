/**
 * Whether any error in the chain has a message matching `pattern`. Drizzle
 * wraps driver errors as "Failed query: …" and keeps the SQLite message on
 * `cause`, so checking only the outer message misses it.
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
	return errorChainMatches(error, /no such table/i);
}

export function isUniqueConstraintError(error: unknown): boolean {
	return errorChainMatches(error, /UNIQUE constraint failed/i);
}

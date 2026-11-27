/**
 * Page-size query parameter: a positive integer capped at `max`, `fallback` when missing or junk.
 * A negative or non-numeric value must never reach `.limit()`: SQLite treats `LIMIT -1` as no limit
 * and other databases reject it.
 */
export function parseLimit(value: string | null, fallback: number, max: number): number {
	if (value === null) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, max);
}

/**
 * `mailboxIds=id1,id2` query parameter: a comma-separated mailbox list. `ids` stays `null`
 * when the parameter is absent, so a caller can tell "no subset" from an explicit list;
 * a blank element is an error rather than a silently shorter list.
 */
export function parseMailboxIdList(value: string | null): { ids: string[] | null; error?: string } {
	if (value === null) return { ids: null };
	const ids = value.split(",").map((id) => id.trim());
	if (ids.some((id) => id.length === 0)) return { ids: null, error: "mailboxIds contains an empty mailbox id" };
	return { ids: [...new Set(ids)] };
}

/** Row offset query parameter: a non-negative integer, 0 when missing or junk. */
export function parseOffset(value: string | null): number {
	const parsed = Number(value ?? 0);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** One run reads at most this many messages: 25 every 5 minutes. */
export const BACKFILL_BATCH = 25;
/**
 * Rows the backfill may read in a day across the whole installation. A promoted row costs about 6 D1 row writes
 * (the row, its indexes, the change-log entry), so 2,000 rows is about 12,000 writes of D1 Free's 100,000 a day.
 */
export const BACKFILL_DAILY_CAP = 2000;
/** The UTC day a timestamp falls on, as a whole number. */
export const backfillDay = (now: Date): number => Math.floor(now.getTime() / 86_400_000);
/** Only mail of the last 90 days is classified. */
export const BACKFILL_WINDOW_DAYS = 90;
/** Bytes read from the start of each raw message: enough for every header the detector looks at. */
export const BACKFILL_HEAD_BYTES = 32_768;
/** Rows handled between two saves of the cursor, so a killed run loses at most one chunk. */
export const BACKFILL_CHUNK = 10;
/** A `running` row not touched for this long belongs to a run that died. */
export const BACKFILL_STALE_MS = 15 * 60_000;
/** Consecutive runs that died without saving any progress before the job is marked failed. */
export const BACKFILL_MAX_STALLS = 3;

/** Keyset position `(created_at, id)` of the last row handled, stored as JSON in `backfill_cursor`. */
export type BackfillCursor = { createdAt: number; id: string };

export const serializeCursor = (cursor: BackfillCursor): string => JSON.stringify(cursor);

export function parseCursor(value: string | null): BackfillCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as { createdAt?: unknown; id?: unknown };
		return typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) && typeof parsed.id === "string" ? { createdAt: parsed.createdAt, id: parsed.id } : null;
	} catch {
		return null;
	}
}

export const backfillCutoff = (now: Date): Date => new Date(now.getTime() - BACKFILL_WINDOW_DAYS * 86_400_000);

import { and, eq, gte, isNotNull, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

/**
 * Deletes an event and, when it is the master of a DAV resource, the override rows (moved occurrences) that point at it.
 * One statement, so the change log sees the resource destroyed once and never an override "updated" under a missing parent.
 */
export async function deleteSeriesRows(db: Db, userId: string, id: string): Promise<void> {
	await db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), or(eq(calendarEvents.id, id), eq(calendarEvents.davObjectId, id))));
}

/** "This and following": override rows that replace an occurrence at or after `from` are cut off with the series. */
export async function deleteOverridesFrom(db: Db, userId: string, masterId: string, from: Date): Promise<void> {
	await db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.davObjectId, masterId), gte(calendarEvents.recurrenceId, from)));
}

/** "This and following" edit: the new series takes over from `splitAt`, the old one is ended by `endPatch`, and the old series' overrides at or after the split are cut off with it. */
export async function splitSeriesRows(db: Db, userId: string, existing: { id: string; davObjectId: string | null }, splitAt: Date, fresh: typeof calendarEvents.$inferInsert, endPatch: Partial<typeof calendarEvents.$inferInsert>): Promise<void> {
	await db.insert(calendarEvents).values(fresh);
	await db.update(calendarEvents).set(endPatch).where(eq(calendarEvents.id, existing.id));
	if (existing.davObjectId === existing.id) await deleteOverridesFrom(db, userId, existing.id, splitAt);
}

/** Moves each override's recurrence_id with its series (see shiftCustomSeries), so it still replaces the same occurrence. */
export async function shiftOverrides(db: Db, userId: string, masterId: string, shift: (at: Date) => Date): Promise<void> {
	const rows = await db.select({ id: calendarEvents.id, recurrenceId: calendarEvents.recurrenceId }).from(calendarEvents)
		.where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.davObjectId, masterId), isNotNull(calendarEvents.recurrenceId)));
	for (const row of rows) await db.update(calendarEvents).set({ recurrenceId: shift(row.recurrenceId!) }).where(eq(calendarEvents.id, row.id));
}

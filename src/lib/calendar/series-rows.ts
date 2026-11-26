import { and, eq, gte, isNotNull, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, davCalendarObjects } from "@/db/schema";
import { calendarCollectionId } from "@/lib/dav/changes";

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

/** The statements of a "this and following" edit, for a caller that runs them inside a batch of its own. */
export function splitSeriesStatements(db: Db, userId: string, existing: { id: string; davObjectId: string | null }, splitAt: Date, fresh: typeof calendarEvents.$inferInsert, endPatch: Partial<typeof calendarEvents.$inferInsert>) {
	const statements = [db.insert(calendarEvents).values(fresh), db.update(calendarEvents).set(endPatch).where(eq(calendarEvents.id, existing.id))];
	if (existing.davObjectId === existing.id) statements.push(db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.davObjectId, existing.id), gte(calendarEvents.recurrenceId, splitAt))) as never);
	return statements;
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

/**
 * Moves an event and, when it is the master of a DAV resource, every override row that points at it to another calendar
 * (null is the owner's default). One statement: the change log keys an override under its parent's collection, so moving the
 * master first would log the overrides against the collection the parent just left.
 */
export function moveSeriesStatement(db: Db, userId: string, masterId: string, calendarId: string | null) {
	return db.update(calendarEvents).set({ calendarId }).where(and(eq(calendarEvents.userId, userId), or(eq(calendarEvents.id, masterId), eq(calendarEvents.davObjectId, masterId))));
}

/**
 * The statements that move a resource to another calendar: the rows, then its stored CalDAV resource, which names the collection it is
 * served from (unique per collection by name and UID, so it must follow in the same batch).
 */
export function moveSeriesStatements(db: Db, userId: string, masterId: string, calendarId: string | null) {
	return [moveSeriesStatement(db, userId, masterId, calendarId), db.update(davCalendarObjects).set({ collectionId: calendarId ?? calendarCollectionId(userId) }).where(eq(davCalendarObjects.id, masterId))];
}

/** Only the rows: a caller that has to keep the stored CalDAV resource in step (a web move does) uses `moveSeriesStatements` in its batch. */
export async function moveSeriesToCalendar(db: Db, userId: string, masterId: string, calendarId: string | null): Promise<void> {
	await moveSeriesStatement(db, userId, masterId, calendarId);
}

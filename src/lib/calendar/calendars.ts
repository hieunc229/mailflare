import { and, asc, count, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, calendarShares, davChanges, davCollections, davSyncState } from "@/db/schema";
import { excluded, greatest, matchNothing } from "@/db/sql";
import { calendarCollectionId } from "@/lib/dav/changes";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_VALUES } from "@/lib/folders/colors";
import { newId } from "@/lib/ids";
import type { CalendarDeleteResult, CalendarFailure, CalendarInput, CalendarResult, CalendarSummary, EventCalendarResult } from "./calendars-types";

type Db = ReturnType<typeof getDb>;

/** Per user, the default calendar included (spec F9 section 5). */
export const MAX_CALENDARS = 50;
export const MAX_CALENDAR_NAME = 100;
export const MAX_CALENDAR_DESCRIPTION = 500;
const CHUNK = 50;
/** Ids per statement when deleting by id list: under D1's 100 bound parameters with the other conditions. */
const DELETE_CHUNK = 90;

const fail = (status: CalendarFailure["status"], error: string): CalendarFailure => ({ ok: false, status, error });

/** dav_collections colours come from Apple clients as `#RRGGBBAA`; the web palette is the six-digit prefix. */
export function paletteColor(value: string | null): string {
	const six = value?.slice(0, 7).toLowerCase();
	return FOLDER_COLOR_VALUES.find((color) => color === six) ?? DEFAULT_FOLDER_COLOR;
}

function summarize(userId: string, row: typeof davCollections.$inferSelect | undefined, eventCount = 0, id = row?.id ?? calendarCollectionId(userId)): CalendarSummary {
	return { id, name: row?.displayName ?? null, color: paletteColor(row?.color ?? null), description: row?.description ?? "", isDefault: id === calendarCollectionId(userId), role: "owner", eventCount };
}

/** Ids of the user's calendars, the default one always among them (its row is lazy). A cheap read for labelling events in a range. */
export async function ownCalendarIds(db: Db, userId: string): Promise<string[]> {
	const rows = await db.select({ id: davCollections.id }).from(davCollections).where(and(eq(davCollections.userId, userId), eq(davCollections.kind, "calendar")));
	return [...new Set([calendarCollectionId(userId), ...rows.map((row) => row.id)])];
}

/** The default calendar first (synthesised until it has a row), then the others oldest first. */
export async function listOwnCalendars(db: Db, userId: string): Promise<CalendarSummary[]> {
	const rows = await db.select().from(davCollections).where(and(eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))).orderBy(asc(davCollections.createdAt), asc(davCollections.id));
	const defaultId = calendarCollectionId(userId);
	const counts = await db.select({ calendarId: calendarEvents.calendarId, events: count() }).from(calendarEvents).where(eq(calendarEvents.userId, userId)).groupBy(calendarEvents.calendarId);
	const known = new Set(rows.map((row) => row.id).concat(defaultId));
	// Events with no calendar, or one whose row is gone, are in the default calendar (spec 8.10).
	const eventsIn = (id: string) => counts.filter((entry) => (id === defaultId ? !entry.calendarId || entry.calendarId === id || !known.has(entry.calendarId) : entry.calendarId === id)).reduce((total, entry) => total + Number(entry.events), 0);
	return [summarize(userId, rows.find((row) => row.id === defaultId), eventsIn(defaultId)), ...rows.filter((row) => row.id !== defaultId).map((row) => summarize(userId, row, eventsIn(row.id)))];
}

type Parsed = { name?: string; color?: string; description?: string };

function parseInput(input: CalendarInput, requireName: boolean): Parsed | CalendarFailure {
	const out: Parsed = {};
	if (input.name !== undefined || requireName) {
		const name = typeof input.name === "string" ? input.name.trim() : "";
		if (!name || name.length > MAX_CALENDAR_NAME) return fail(400, `Enter a calendar name of 1 to ${MAX_CALENDAR_NAME} characters`);
		out.name = name;
	}
	if (input.color !== undefined) {
		const color = FOLDER_COLOR_VALUES.find((value) => value === input.color);
		if (!color) return fail(400, "Choose a calendar colour");
		out.color = color;
	}
	if (input.description !== undefined) {
		if (typeof input.description !== "string" || input.description.trim().length > MAX_CALENDAR_DESCRIPTION) return fail(400, `Descriptions are limited to ${MAX_CALENDAR_DESCRIPTION} characters`);
		out.description = input.description.trim();
	}
	return out;
}

const isFailure = (value: Parsed | CalendarFailure): value is CalendarFailure => "ok" in value;

export async function createCalendar(db: Db, userId: string, input: CalendarInput): Promise<CalendarResult> {
	const parsed = parseInput(input, true);
	if (isFailure(parsed)) return parsed;
	const [{ owned }] = await db.select({ owned: count() }).from(davCollections).where(and(eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"), ne(davCollections.id, calendarCollectionId(userId))));
	// The default calendar always exists, so it takes one of the places whether or not it has a row.
	if (Number(owned) + 1 >= MAX_CALENDARS) return fail(409, `You can have up to ${MAX_CALENDARS} calendars`);
	const id = `cal:${newId("cal")}`;
	const now = new Date();
	const row = { id, userId, kind: "calendar" as const, displayName: parsed.name!, color: parsed.color ?? DEFAULT_FOLDER_COLOR, description: parsed.description ?? "", sortOrder: null, deadProps: "{}", seededAt: null, createdAt: now, updatedAt: now };
	await db.insert(davCollections).values(row);
	// The count above and this insert are not one step; a concurrent create may have taken the last place, so count again and give the place back.
	// Two creates racing for the last place may both be refused (each sees the other's row); the user retries, and the cap is never exceeded.
	const [{ after }] = await db.select({ after: count() }).from(davCollections).where(and(eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"), ne(davCollections.id, calendarCollectionId(userId))));
	if (Number(after) + 1 > MAX_CALENDARS) {
		await db.delete(davCollections).where(eq(davCollections.id, id));
		return fail(409, `You can have up to ${MAX_CALENDARS} calendars`);
	}
	return { ok: true, calendar: summarize(userId, row) };
}

/** Owner edit of name, colour and description. The default calendar gets its row on the first edit. */
export async function updateCalendar(db: Db, userId: string, calendarId: string, input: CalendarInput): Promise<CalendarResult> {
	const parsed = parseInput(input, false);
	if (isFailure(parsed)) return parsed;
	const isDefault = calendarId === calendarCollectionId(userId);
	const [existing] = await db.select().from(davCollections).where(and(eq(davCollections.id, calendarId), eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))).limit(1);
	if (!existing && !isDefault) return fail(404, "Calendar not found");
	const patch = { ...(parsed.name !== undefined ? { displayName: parsed.name } : {}), ...(parsed.color !== undefined ? { color: parsed.color } : {}), ...(parsed.description !== undefined ? { description: parsed.description } : {}) };
	const now = new Date();
	if (existing) {
		await db.update(davCollections).set({ ...patch, updatedAt: now }).where(eq(davCollections.id, calendarId));
		return { ok: true, calendar: summarize(userId, { ...existing, ...patch }) };
	}
	const row = { id: calendarId, userId, kind: "calendar" as const, displayName: null, color: null, description: null, sortOrder: null, deadProps: "{}", seededAt: null, createdAt: now, updatedAt: now, ...patch };
	await db.insert(davCollections).values(row).onConflictDoUpdate({ target: davCollections.id, set: { ...patch, updatedAt: now } });
	return { ok: true, calendar: summarize(userId, row) };
}

/**
 * Deletes a calendar and its events, in one batch. The events go first, by statement, so the change log writes a destroyed entry
 * for each (a foreign-key cascade would not fire the triggers on MySQL); a series goes with its override rows even when one lost
 * its calendar id (deleted by master id, in chunks, never by a subquery on the same table). The log rows written under the
 * calendar are then filed under the user's default calendar, which is what a phone sees as `default/` until CalDAV serves each
 * calendar itself, so the phone still learns of the deletions. The collection row cascades its grants.
 */
export async function deleteCalendar(db: Db, userId: string, calendarId: string): Promise<CalendarDeleteResult> {
	const defaultId = calendarCollectionId(userId);
	if (calendarId === defaultId) return fail(409, "The default calendar cannot be deleted");
	const [existing] = await db.select().from(davCollections).where(and(eq(davCollections.id, calendarId), eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))).limit(1);
	if (!existing) return fail(404, "Calendar not found");
	const [{ events }] = await db.select({ events: count() }).from(calendarEvents).where(and(eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.userId, userId)));
	const masters = (await db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.userId, userId), eq(calendarEvents.davObjectId, calendarEvents.id)))).map((row) => row.id);
	const [calendarState] = await db.select({ floor: davSyncState.floor }).from(davSyncState).where(eq(davSyncState.collectionId, calendarId)).limit(1);
	const statements: unknown[] = [];
	for (let index = 0; index < masters.length; index += DELETE_CHUNK) statements.push(db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), inArray(calendarEvents.davObjectId, masters.slice(index, index + DELETE_CHUNK)))));
	statements.push(
		db.delete(calendarEvents).where(and(eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.userId, userId))),
		db.update(davChanges).set({ collectionId: defaultId }).where(eq(davChanges.collectionId, calendarId)),
	);
	// The default calendar's floor is the highest among the user's calendars, so removing this one must not lower it: an offline
	// phone whose token lies between the floors would otherwise be accepted after the rows that say what it missed are pruned.
	if (calendarState && Number(calendarState.floor) > 0) {
		statements.push(db.insert(davSyncState).values({ collectionId: defaultId, epoch: crypto.randomUUID(), floor: Number(calendarState.floor) })
			.onConflictDoUpdate({ target: davSyncState.collectionId, set: { floor: greatest(sql`${davSyncState.floor}`, excluded(davSyncState.floor)) } }));
	}
	statements.push(
		db.delete(davSyncState).where(eq(davSyncState.collectionId, calendarId)),
		db.delete(davCollections).where(and(eq(davCollections.id, calendarId), eq(davCollections.userId, userId))),
	);
	await db.batch(statements as never);
	return { ok: true, name: existing.displayName, eventCount: Number(events) };
}

/**
 * Turns the calendar an event write names into what `calendar_events.calendar_id` stores: undefined (not sent, keep),
 * null (the default calendar, however it was spelled) or the id of a calendar the user owns.
 */
export async function resolveEventCalendar(db: Db, userId: string, requested: unknown, current?: string | null): Promise<EventCalendarResult> {
	if (requested === undefined) return { ok: true, calendarId: undefined };
	// Naming the calendar the event already has changes nothing, so an event whose calendar row is gone stays editable.
	if (typeof requested === "string" && current && requested === current) return { ok: true, calendarId: undefined };
	if (requested === null || requested === calendarCollectionId(userId)) return { ok: true, calendarId: null };
	if (typeof requested !== "string") return fail(400, "Invalid calendar");
	const [row] = await db.select({ id: davCollections.id }).from(davCollections).where(and(eq(davCollections.id, requested), eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))).limit(1);
	return row ? { ok: true, calendarId: row.id } : fail(404, "Calendar not found");
}

/** The calendar an event row lives in (D-1: one helper, never inline). */
export function eventCalendarId(event: { calendarId: string | null; userId: string }, known?: Set<string>): string {
	const defaultId = calendarCollectionId(event.userId);
	// A calendar whose row is missing (a partial restore) shows its events in the default calendar, never loses them.
	return event.calendarId && (!known || known.has(event.calendarId)) ? event.calendarId : defaultId;
}

/** Events of the user's own calendars among `calendarIds` (at most CHUNK ids, so well under D1's 100 bound parameters). */
export function calendarFilter(userId: string, calendarIds: string[]): SQL {
	const defaultId = calendarCollectionId(userId);
	const named = [...new Set(calendarIds)].filter((id) => id !== defaultId).slice(0, CHUNK);
	const wantsDefault = calendarIds.includes(defaultId);
	const parts: SQL[] = [];
	if (wantsDefault) parts.push(or(isNull(calendarEvents.calendarId), eq(calendarEvents.calendarId, defaultId), sql`${calendarEvents.calendarId} not in (select ${davCollections.id} from ${davCollections} where ${davCollections.userId} = ${userId} and ${davCollections.kind} = 'calendar')`)!);
	if (named.length) parts.push(inArray(calendarEvents.calendarId, named));
	return parts.length ? and(eq(calendarEvents.userId, userId), or(...parts))! : matchNothing;
}

/**
 * Account transfer: the source's extra calendars become the recipient's, and the recipient's own grants on them (now pointless) go.
 * The default calendar is not moved: its events follow the user id, and an explicit default id on an event is written back as null.
 * Returns the moved calendar ids. The caller changes the events' user id afterwards.
 */
export async function transferCalendars(db: Db, fromId: string, toId: string): Promise<string[]> {
	const defaultId = calendarCollectionId(fromId);
	await db.update(calendarEvents).set({ calendarId: null }).where(and(eq(calendarEvents.userId, fromId), eq(calendarEvents.calendarId, defaultId)));
	const rows = await db.select({ id: davCollections.id }).from(davCollections).where(and(eq(davCollections.userId, fromId), eq(davCollections.kind, "calendar"), ne(davCollections.id, defaultId)));
	const ids = rows.map((row) => row.id);
	for (let index = 0; index < ids.length; index += CHUNK) {
		const group = ids.slice(index, index + CHUNK);
		await db.update(davCollections).set({ userId: toId }).where(inArray(davCollections.id, group));
		await db.delete(calendarShares).where(and(inArray(calendarShares.calendarId, group), eq(calendarShares.granteeUserId, toId)));
	}
	return ids;
}

/**
 * Statements for the start of a write batch that puts rows into `calendarId`: they fail the whole batch (a duplicate key, which
 * SQLite, D1, PostgreSQL and MySQL all refuse in any mode) when the calendar row is gone, so a concurrent `deleteCalendar` cannot
 * leave events that name a missing calendar. The caller maps `isUniqueConstraintError` to 409. Same device as `staleGuard` in
 * `dav/writes.ts`. Nothing else guards `calendar_id`: it has no foreign key (the default calendar's row is lazy), and a partial
 * restore that would leave dangling ids is refused by the backup importer, so no read path has to cope with them.
 */
export function calendarExistsGuard(db: Db, userId: string, calendarId: string): unknown[] {
	const token = crypto.randomUUID();
	const [first, second] = [`guard:${token}:a`, `guard:${token}:b`];
	const missing = sql`not exists (select 1 from ${davCollections} where ${and(eq(davCollections.id, calendarId), eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))})`;
	return [
		db.insert(davSyncState).values([
			{ collectionId: first, epoch: "guard", floor: 0 },
			{ collectionId: sql`case when ${missing} then ${first} else ${second} end` as unknown as string, epoch: "guard", floor: 0 },
		]),
		db.delete(davSyncState).where(inArray(davSyncState.collectionId, [first, second])),
	];
}

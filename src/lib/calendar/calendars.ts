import { and, asc, count, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, calendarShares, davCollections } from "@/db/schema";
import { matchNothing } from "@/db/sql";
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

const fail = (status: CalendarFailure["status"], error: string): CalendarFailure => ({ ok: false, status, error });

/** dav_collections colours come from Apple clients as `#RRGGBBAA`; the web palette is the six-digit prefix. */
function paletteColor(value: string | null): string {
	const six = value?.slice(0, 7).toLowerCase();
	return FOLDER_COLOR_VALUES.find((color) => color === six) ?? DEFAULT_FOLDER_COLOR;
}

function summarize(userId: string, row: typeof davCollections.$inferSelect | undefined, id = row?.id ?? calendarCollectionId(userId)): CalendarSummary {
	return { id, name: row?.displayName ?? null, color: paletteColor(row?.color ?? null), description: row?.description ?? "", isDefault: id === calendarCollectionId(userId), role: "owner" };
}

/** The default calendar first (synthesised until it has a row), then the others oldest first. */
export async function listOwnCalendars(db: Db, userId: string): Promise<CalendarSummary[]> {
	const rows = await db.select().from(davCollections).where(and(eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))).orderBy(asc(davCollections.createdAt), asc(davCollections.id));
	const defaultId = calendarCollectionId(userId);
	return [summarize(userId, rows.find((row) => row.id === defaultId)), ...rows.filter((row) => row.id !== defaultId).map((row) => summarize(userId, row))];
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
	await db.insert(davCollections).values(row).onConflictDoNothing();
	return { ok: true, calendar: summarize(userId, row) };
}

/**
 * Deletes a calendar and its events. The events go first, by statement, so the change log writes a destroyed entry for each
 * (a foreign-key cascade would not fire the triggers on MySQL); the collection row then cascades its grants.
 */
export async function deleteCalendar(db: Db, userId: string, calendarId: string): Promise<CalendarDeleteResult> {
	if (calendarId === calendarCollectionId(userId)) return fail(409, "The default calendar cannot be deleted");
	const [existing] = await db.select().from(davCollections).where(and(eq(davCollections.id, calendarId), eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))).limit(1);
	if (!existing) return fail(404, "Calendar not found");
	const [{ events }] = await db.select({ events: count() }).from(calendarEvents).where(and(eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.userId, userId)));
	await db.delete(calendarEvents).where(and(eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.userId, userId)));
	await db.delete(davCollections).where(and(eq(davCollections.id, calendarId), eq(davCollections.userId, userId)));
	return { ok: true, name: existing.displayName, eventCount: Number(events) };
}

/**
 * Turns the calendar an event write names into what `calendar_events.calendar_id` stores: undefined (not sent, keep),
 * null (the default calendar, however it was spelled) or the id of a calendar the user owns.
 */
export async function resolveEventCalendar(db: Db, userId: string, requested: unknown): Promise<EventCalendarResult> {
	if (requested === undefined) return { ok: true, calendarId: undefined };
	if (requested === null || requested === calendarCollectionId(userId)) return { ok: true, calendarId: null };
	if (typeof requested !== "string") return fail(404, "Calendar not found");
	const [row] = await db.select({ id: davCollections.id }).from(davCollections).where(and(eq(davCollections.id, requested), eq(davCollections.userId, userId), eq(davCollections.kind, "calendar"))).limit(1);
	return row ? { ok: true, calendarId: row.id } : fail(404, "Calendar not found");
}

/** The calendar an event row lives in (D-1: one helper, never inline). */
export const eventCalendarId = (event: { calendarId: string | null; userId: string }) => event.calendarId ?? calendarCollectionId(event.userId);

/** Events of the user's own calendars among `calendarIds` (at most CHUNK ids, so well under D1's 100 bound parameters). */
export function calendarFilter(userId: string, calendarIds: string[]): SQL {
	const defaultId = calendarCollectionId(userId);
	const named = [...new Set(calendarIds)].filter((id) => id !== defaultId).slice(0, CHUNK);
	const wantsDefault = calendarIds.includes(defaultId);
	const parts: SQL[] = [];
	if (wantsDefault) parts.push(or(isNull(calendarEvents.calendarId), eq(calendarEvents.calendarId, defaultId))!);
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

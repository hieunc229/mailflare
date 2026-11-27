import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, calendarResourceBookings } from "@/db/schema";
import { overlapsWindow } from "./busy-expand";
import { calendarCollectionId } from "@/lib/dav/changes";
import { grantedCalendars } from "./shares";
import type { CalendarRole } from "./shares-types";
import { redactEvent } from "./visibility";

type Db = ReturnType<typeof getDb>;

/** Rooms per schedule request, and the events read for them. */
export const MAX_SCHEDULE_ROOMS = 20;
export const MAX_SCHEDULE_ROWS = 2000;
const BOOKING_CHUNK = 90;

export type RoomEventView = {
	id: string;
	resourceId: string;
	title: string;
	startsAt: Date;
	endsAt: Date;
	repeat: string;
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	rrule: string | null;
	excludedOccurrences: string;
	timeZone: string | null;
	allDay: boolean;
	davObjectId: string | null;
	recurrenceId: Date | null;
	color: string | null;
	/** The viewer may not read this event: the title is a placeholder to translate. */
	redacted: boolean;
};

/**
 * What the rooms' schedules show a viewer (spec F9 8.7): the accepted bookings' events (and the moved occurrences of those
 * series) in the window, with the title only for events the viewer may read; everything else is "Busy" with nothing about
 * who, where or what. Never a calendar id, owner, guest or description. Declined bookings hold nothing, so they are not shown.
 */
export async function listRoomEvents(db: Db, user: { id: string }, resourceIds: string[], range: { start: Date; end: Date }): Promise<{ events: RoomEventView[]; /** More bookings exist in the window than the cap lets through: the earliest are returned. */ truncated: boolean }> {
	const ids = [...new Set(resourceIds)];
	if (!ids.length) return { events: [], truncated: false };
	const found = await db.select({ resourceId: calendarResourceBookings.resourceId, bookedEventId: calendarResourceBookings.eventId, event: calendarEvents }).from(calendarResourceBookings)
		.innerJoin(calendarEvents, or(eq(calendarEvents.id, calendarResourceBookings.eventId), eq(calendarEvents.davObjectId, calendarResourceBookings.eventId)))
		.where(and(inArray(calendarResourceBookings.resourceId, ids), eq(calendarResourceBookings.status, "accepted"), overlapsWindow(range.start, range.end))).orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id)).limit(MAX_SCHEDULE_ROWS + 1);
	const truncated = found.length > MAX_SCHEDULE_ROWS;
	const rows = found.slice(0, MAX_SCHEDULE_ROWS);
	// A moved occurrence is private when its series is, whatever CLASS it carries itself (as in the calendar lists).
	const booked = [...new Set(rows.map((row) => row.bookedEventId))];
	const privateSeries = new Set<string>();
	for (let index = 0; index < booked.length; index += BOOKING_CHUNK) for (const row of await db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(inArray(calendarEvents.id, booked.slice(index, index + BOOKING_CHUNK)), eq(calendarEvents.isPrivate, true)))) privateSeries.add(row.id);
	// The viewer's roles come from one read of their grants, never a lookup per organiser or calendar. A grant counts only for events whose
	// owner is the calendar's owner and is active with Calendar on (what `grantedCalendars` returns), as `getEventAccess` decides it.
	const grants = rows.some(({ event }) => event.userId !== user.id) ? await grantedCalendars(db, user.id) : [];
	const granted = new Map(grants.map((grant) => [`${grant.id}|${grant.ownerId}`, grant.role as CalendarRole]));
	const views: RoomEventView[] = [];
	for (const { resourceId, bookedEventId, event } of rows) {
		const role: CalendarRole | null = event.userId === user.id ? "owner" : granted.get(`${event.calendarId ?? calendarCollectionId(event.userId)}|${event.userId}`) ?? null;
		const shown = redactEvent(privateSeries.has(bookedEventId) ? { ...event, isPrivate: true } : event, role && role !== "freebusy" ? role : "freebusy");
		views.push({
			id: event.id, resourceId, title: shown.title, startsAt: event.startsAt, endsAt: event.endsAt, repeat: event.repeat, repeatDays: event.repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: event.repeatUntil,
			rrule: event.rrule, excludedOccurrences: event.excludedOccurrences, timeZone: event.timeZone, allDay: event.allDay, davObjectId: event.davObjectId, recurrenceId: event.recurrenceId,
			color: shown.redacted ? null : event.color, redacted: shown.redacted === true,
		});
	}
	return { events: views, truncated };
}

export type EventRoom = { resourceId: string; status: "accepted" | "declined"; conflictAt: string | null };

/** The rooms each of these events is booked for, for the editor's chips. */
export async function roomsByEvent(db: Db, eventIds: string[]): Promise<Map<string, EventRoom[]>> {
	const map = new Map<string, EventRoom[]>();
	for (let index = 0; index < eventIds.length; index += BOOKING_CHUNK) {
		for (const row of await db.select({ eventId: calendarResourceBookings.eventId, resourceId: calendarResourceBookings.resourceId, status: calendarResourceBookings.status, conflictAt: calendarResourceBookings.conflictAt }).from(calendarResourceBookings).where(inArray(calendarResourceBookings.eventId, eventIds.slice(index, index + BOOKING_CHUNK)))) {
			const list = map.get(row.eventId) ?? [];
			list.push({ resourceId: row.resourceId, status: row.status, conflictAt: row.conflictAt?.toISOString() ?? null });
			map.set(row.eventId, list);
		}
	}
	for (const list of map.values()) list.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
	return map;
}

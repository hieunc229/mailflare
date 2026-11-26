import type { calendarEvents } from "@/db/schema";
import { buildVevent, eventZone, type FeedEvent } from "@/lib/calendar/feed";
import { formatIcsUtc, joinIcsLines } from "@/lib/calendar/ics";
import { buildVtimezone } from "@/lib/calendar/vtimezone";
import { redactEvent } from "@/lib/calendar/visibility";
import type { CalendarRole } from "@/lib/calendar/shares-types";
import { feedRow, mergeCalendarBody } from "./calendar-merge";

export type EventRow = typeof calendarEvents.$inferSelect;

/** One CalDAV resource: the master row, its override rows (moved occurrences of a DAV series) and the names it is served under. */
export type CalendarResource = {
	id: string;
	name: string;
	uid: string;
	master: EventRow;
	overrides: EventRow[];
	/** Bytes of the stored body (the `size` column), known without loading it; undefined for a native event. */
	size?: number;
	/** The iCalendar text a client PUT, for a resource a DAV client wrote; `fresh` when no row changed since (see rowsHash). */
	stored?: { body: string; fresh: boolean };
	/** The viewer's role in the collection; anything but the owner is served a body generated from the rows and redacted for it (D-6, D-12). */
	role?: CalendarRole;
};

/** The href segment of a resource: the stored name of a DAV-created one, `<id>.ics` for a native event. */
export const nativeResourceName = (id: string) => `${id}.ics`;
export const nativeUid = (id: string) => `${id}@mailflare`;


/** Latest change among the rows of a resource, for Last-Modified. */
export function resourceUpdatedAt(resource: CalendarResource): Date {
	return [resource.master, ...resource.overrides].reduce((latest, row) => (row.updatedAt > latest ? row.updatedAt : latest), resource.master.updatedAt);
}

/**
 * The iCalendar text of a resource, generated from its rows with the same VEVENT builder as the subscription
 * feed and deterministic (DTSTAMP is the row's update time), so it only changes when the rows do. Override rows
 * become VEVENTs with RECURRENCE-ID, and their instants are taken out of the master's EXDATEs because the
 * override stands in for them. Every zone written gets a VTIMEZONE. The first reminder of each event is written as a
 * VALARM (spec 7.3), and an all-day event that has no zone of its own gets its dates in `userZone`.
 */
export function renderCalendarObject(resource: CalendarResource, userZone?: string | null): string {
	if (resource.role && resource.role !== "owner") resource = viewedBy(resource, resource.role);
	if (resource.stored?.fresh) return resource.stored.body;
	// A Mailflare-side edit of a DAV event: the mapped properties are rewritten into what the client sent (spec 7.3).
	const merged = resource.stored && mergeCalendarBody(resource.stored.body, resource, userZone);
	if (merged) return merged;
	const { master, overrides, uid } = resource;
	const overridden = new Set(overrides.flatMap((row) => (row.recurrenceId ? [row.recurrenceId.getTime()] : [])));
	const parts: { event: FeedEvent; recurrenceId?: Date }[] = [{ event: feedRow(master, overridden) }];
	for (const row of overrides) if (row.recurrenceId) parts.push({ event: feedRow(row), recurrenceId: row.recurrenceId });

	const zones = new Map<string, number>();
	for (const { event, recurrenceId } of parts) {
		const zone = eventZone(event, recurrenceId, userZone);
		// A DATE value names no zone, so an all-day event needs no VTIMEZONE.
		if (zone && !event.allDay) zones.set(zone, Math.min(zones.get(zone) ?? Infinity, event.startsAt.getUTCFullYear()));
	}
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN"];
	for (const [zone, year] of zones) lines.push(...buildVtimezone(zone, year));
	for (const { event, recurrenceId } of parts) lines.push(...buildVevent(event, { stamp: formatIcsUtc(event.updatedAt ?? master.updatedAt), recurrenceId, uid, fallbackZone: userZone, alarm: true }));
	lines.push("END:VCALENDAR");
	return joinIcsLines(lines);
}

/**
 * What a viewer other than the owner gets of a resource (D-6, D-12): every row through `redactEvent`, rendered per request, and never the
 * body a client PUT (it can hold the owner's alarms and private text). A moved occurrence belongs to its series, so it is private when the
 * series is, as in the events API.
 */
function viewedBy(resource: CalendarResource, role: CalendarRole): CalendarResource {
	const view = (row: EventRow): EventRow => redactEvent({ ...row, isPrivate: row.isPrivate || resource.master.isPrivate }, role);
	return { ...resource, stored: undefined, master: redactEvent(resource.master, role), overrides: resource.overrides.map(view) };
}

/** A VCALENDAR holding only the VTIMEZONE of a zone, the value of `C:calendar-timezone`. */
export function calendarTimezoneObject(zone: string): string {
	return joinIcsLines(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", ...buildVtimezone(zone, new Date().getUTCFullYear()), "END:VCALENDAR"]);
}

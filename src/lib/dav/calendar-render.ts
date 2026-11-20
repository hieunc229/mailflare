import type { calendarEvents } from "@/db/schema";
import { buildVevent, eventZone, type FeedEvent } from "@/lib/calendar/feed";
import { formatIcsUtc, joinIcsLines } from "@/lib/calendar/ics";
import { parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { buildVtimezone } from "@/lib/calendar/vtimezone";

export type EventRow = typeof calendarEvents.$inferSelect;

/** One CalDAV resource: the master row, its override rows (moved occurrences of a DAV series) and the names it is served under. */
export type CalendarResource = { id: string; name: string; uid: string; master: EventRow; overrides: EventRow[] };

/** The href segment of a resource: the stored name of a DAV-created one, `<id>.ics` for a native event. */
export const nativeResourceName = (id: string) => `${id}.ics`;
export const nativeUid = (id: string) => `${id}@mailflare`;

const feedRow = (row: EventRow, excluded?: Set<number>): FeedEvent => ({
	...row,
	repeat: row.repeat,
	excludedOccurrences: excluded ? JSON.stringify(parseExcludedOccurrences(row.excludedOccurrences).filter((at) => !excluded.has(at))) : row.excludedOccurrences,
});

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

/** A VCALENDAR holding only the VTIMEZONE of a zone, the value of `C:calendar-timezone`. */
export function calendarTimezoneObject(zone: string): string {
	return joinIcsLines(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", ...buildVtimezone(zone, new Date().getUTCFullYear()), "END:VCALENDAR"]);
}

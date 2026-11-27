import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, calendarResourceBookings } from "@/db/schema";
import { expandRowBusy, loadOwnerZones, mergeBusy, needsOwnerZone, overlapsWindow, type BusyInterval } from "./busy-expand";

type Db = ReturnType<typeof getDb>;

/** Rooms per statement: the chunk plus the status and window conditions stay far under D1's 100 bound parameters. */
const ROOM_CHUNK = 40;
/** Booked event rows read for one request, and the expansion work each room may cost it (one per series plus one per occurrence found). */
export const MAX_ROOM_ROWS = 5000;
export const ROOM_WORK_BUDGET = 5000;
const MAX_OCCURRENCES = 2000;

export type RoomBusy = {
	busy: BusyInterval[];
	/** The work limit or the row limit ended the walk: the answer is incomplete, so a caller must not treat the room as free. */
	truncated: boolean;
};
export type RoomBusyOptions = {
	/** An event being edited: its booking is left out so it does not clash with itself. */
	excludeEventId?: string;
	/** Start (ms) of the occurrence of that event whose save splits the series: it and every later one are left out. */
	excludeOccurrence?: number;
};

/**
 * When each room is taken (D-7): the events of its accepted bookings, expanded like anyone's calendar, and the moved occurrences
 * of those series (rows that name the booked event as their master). Nothing is copied into `calendar_events` for a room. A room
 * is occupied whatever the organiser's own "show me as" says, so transparent events count. Every room asked about has an entry.
 */
export async function roomBusyIntervals(db: Db, resourceIds: string[], start: Date, end: Date, options: RoomBusyOptions = {}): Promise<Map<string, RoomBusy>> {
	const from = start.getTime();
	const to = end.getTime();
	const ids = [...new Set(resourceIds)];
	const lists = new Map<string, BusyInterval[]>(ids.map((id) => [id, []]));
	const truncated = new Set<string>();
	const spent = new Map<string, number>();
	for (let index = 0; index < ids.length; index += ROOM_CHUNK) {
		const filters = [inArray(calendarResourceBookings.resourceId, ids.slice(index, index + ROOM_CHUNK)), eq(calendarResourceBookings.status, "accepted"), overlapsWindow(start, end)];
		if (options.excludeEventId && options.excludeOccurrence === undefined) filters.push(ne(calendarResourceBookings.eventId, options.excludeEventId));
		const rows = await db.select({
			resourceId: calendarResourceBookings.resourceId, bookedEventId: calendarResourceBookings.eventId,
			id: calendarEvents.id, userId: calendarEvents.userId, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, timeZone: calendarEvents.timeZone, repeat: calendarEvents.repeat, rrule: calendarEvents.rrule,
			repeatDays: calendarEvents.repeatDays, repeatAnchorDay: calendarEvents.repeatAnchorDay, repeatUntil: calendarEvents.repeatUntil, excludedOccurrences: calendarEvents.excludedOccurrences,
			recurrenceId: calendarEvents.recurrenceId, allDay: calendarEvents.allDay,
		}).from(calendarResourceBookings)
			.innerJoin(calendarEvents, or(eq(calendarEvents.id, calendarResourceBookings.eventId), eq(calendarEvents.davObjectId, calendarResourceBookings.eventId)))
			.where(and(...filters)).limit(MAX_ROOM_ROWS + 1);
		if (rows.length > MAX_ROOM_ROWS) for (const id of ids.slice(index, index + ROOM_CHUNK)) truncated.add(id);
		const zones = rows.some((row) => needsOwnerZone(row)) ? await loadOwnerZones(db, [...new Set(rows.map((row) => row.userId))]) : new Map<string, string>();
		for (const row of rows.slice(0, MAX_ROOM_ROWS)) {
			const edited = options.excludeEventId !== undefined && row.bookedEventId === options.excludeEventId;
			// The edited series' later occurrences, and the moved rows that replaced them, are about to change with the save.
			if (edited && row.id !== row.bookedEventId && (row.recurrenceId === null || row.recurrenceId.getTime() >= options.excludeOccurrence!)) continue;
			if (row.endsAt.getTime() - row.startsAt.getTime() <= 0) continue;
			const used = spent.get(row.resourceId) ?? 0;
			const limit = Math.min(MAX_OCCURRENCES, ROOM_WORK_BUDGET - used);
			if (limit <= 0) { truncated.add(row.resourceId); continue; }
			const walked = expandRowBusy(row, zones.get(row.userId), from, to, limit, edited && row.id === row.bookedEventId ? options.excludeOccurrence : undefined);
			spent.set(row.resourceId, used + walked.used);
			if (walked.truncated) truncated.add(row.resourceId);
			lists.get(row.resourceId)!.push(...walked.busy);
		}
	}
	return new Map(ids.map((id) => [id, { busy: mergeBusy(lists.get(id)!), truncated: truncated.has(id) }]));
}

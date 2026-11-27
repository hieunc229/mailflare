import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { reserveRoomsWithEvent } from "@/lib/calendar/room-booking";
import { requireGuard } from "@/lib/dav/writes";
import { newId } from "@/lib/ids";
import { bookedEventRows, createBookedCalendarEvents, hostBusyCount } from "./create";
import { MAX_BOOKING_ROOMS } from "./resource-ids";
import type { BookingEventRecord } from "./types";

/**
 * Books a slot for a visitor. Without rooms it is one guarded statement (two visitors cannot take the same time). With rooms it is ONE batch
 * (`reserveRoomsWithEvent`): the rooms' token swaps with their guards, a guard that no host is busy, the hosts' events, a guard that every
 * host's event exists, and the accepted room bookings on the first host's event. Either all of it is written or none: a crash between the
 * statements leaves nothing, and no event ever exists without its room. A driver with no transaction (Neon over HTTP) re-checks the room
 * after the write and takes the events back when it loses. Returns false when the time or a room is gone: the caller says "no longer
 * available" and nothing of the booking is left. A multi-host type with rooms, or more than five rooms, is refused here and in `bookingRoomsUsable`.
 */
export async function reserveBooking(env: CloudflareEnv, event: BookingEventRecord, guestName: string, guestEmail: string, startsAt: string, endsAt: string, guestEmails: string[] = [], notes = ""): Promise<boolean> {
	const rooms = [...new Set(event.resourceIds ?? [])];
	// Rooms need one host and at most five rooms, whatever the route checked: the booking lives on the first host's copy, which another host could delete.
	if (rooms.length && (event.hostIds.length > 1 || rooms.length > MAX_BOOKING_ROOMS)) return false;
	if (!rooms.length) return createBookedCalendarEvents(env, event, guestName, guestEmail, startsAt, endsAt, guestEmails, notes);
	const db = getDb(env);
	const ids = event.hostIds.map(() => newId("evt"));
	const startSeconds = Math.floor(new Date(startsAt).getTime() / 1000);
	const endSeconds = Math.floor(new Date(endsAt).getTime() / 1000);
	const busy = hostBusyCount(event.hostIds, startSeconds, endSeconds);
	const create = [
		...requireGuard(db, sql`${busy} > 0`),
		db.insert(calendarEvents).values(bookedEventRows(event, ids, guestName, guestEmail, startsAt, endsAt, guestEmails, notes)),
		...requireGuard(db, sql`(select count(*) from ${calendarEvents} where ${inArray(calendarEvents.id, ids)}) < ${ids.length}`),
	];
	const outcome = await reserveRoomsWithEvent(db, {
		eventId: ids[0], resourceIds: rooms, start: new Date(startsAt), end: new Date(endsAt), create,
		createRefused: async () => Number((await db.all<{ n: number }>(sql`select ${busy} as n`))[0]?.n ?? 0) > 0,
		undo: async () => { try { await db.delete(calendarEvents).where(inArray(calendarEvents.id, ids)); } catch (error) { console.error("Removing an unconfirmed booking failed", error); } },
	});
	return outcome === "booked";
}

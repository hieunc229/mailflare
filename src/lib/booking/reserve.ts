import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { bookRooms } from "@/lib/calendar/room-booking";
import { newId } from "@/lib/ids";
import { createBookedCalendarEvents } from "./create";
import type { BookingEventRecord } from "./types";

/** Takes back events this request created, with whatever rooms they hold. Tried twice: a room must not stay held by an event nobody confirmed. */
async function removeBookedEvents(env: CloudflareEnv, ids: string[]): Promise<void> {
	const db = getDb(env);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			// A booking row cascades with its event on every dialect.
			await db.delete(calendarEvents).where(inArray(calendarEvents.id, ids));
			return;
		} catch (error) {
			console.error("Removing an unconfirmed booking failed", error);
		}
	}
}

/**
 * Books a slot for a visitor: the hosts' events first (one guarded statement, so two visitors cannot take the same time), then
 * the event type's rooms on the first host's event through `bookRooms` (compare-and-swap, first booking wins, D-8). A room's
 * booking hangs on an event row, so the event must exist before the room can be asked for; the order that fails closed is therefore
 * event, room, and take the event back if any room is not accepted. `bookRooms` writes only `accepted` or `declined` rows (never
 * accepted unchecked), so an event that survives a crash between the steps holds no room, and the visitor was never told they were booked.
 * Returns false when the time, or a room, is gone: the caller says "no longer available" and nothing of the booking is left.
 */
export async function reserveBooking(env: CloudflareEnv, event: BookingEventRecord, guestName: string, guestEmail: string, startsAt: string, endsAt: string, guestEmails: string[] = [], notes = ""): Promise<boolean> {
	const rooms = [...new Set(event.resourceIds ?? [])];
	const ids = event.hostIds.map(() => newId("evt"));
	if (!(await createBookedCalendarEvents(env, event, guestName, guestEmail, startsAt, endsAt, guestEmails, notes, ids))) return false;
	if (!rooms.length) return true;
	try {
		const { rooms: outcomes } = await bookRooms(getDb(env), ids[0], rooms);
		if (outcomes.length === rooms.length && outcomes.every((room) => room.status === "accepted")) return true;
	} catch (error) {
		await removeBookedEvents(env, ids);
		throw error;
	}
	await removeBookedEvents(env, ids);
	return false;
}

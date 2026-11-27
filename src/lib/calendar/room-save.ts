import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarResourceBookings, calendarResources } from "@/db/schema";
import { bookRooms } from "./room-booking";

type Db = ReturnType<typeof getDb>;

export type RoomState = { resourceId: string; name: string; status: "accepted" | "declined" | "unconfirmed"; /** First clashing occurrence, ISO. */ conflictAt: string | null };
export type RoomsSummary = {
	rooms: RoomState[];
	/** Declined rooms with up to ten clashing dates each (D-8). */
	resourceConflicts: { resourceId: string; occurrences: string[] }[];
	/** Names of the rooms the guests' invitation lists (accepted ones only). */
	acceptedNames: string[];
};

/** The rooms an event is booked for with their status: what a save that names no rooms keeps. */
export async function bookedRooms(db: Db, eventId: string): Promise<{ id: string; status: "accepted" | "declined"; /** Declined only until the room step checks it again: it was accepted before a write declined it in the same batch. */ pending: boolean }[]> {
	return (await db.select({ id: calendarResourceBookings.resourceId, status: calendarResourceBookings.status, conflictAt: calendarResourceBookings.conflictAt }).from(calendarResourceBookings).where(eq(calendarResourceBookings.eventId, eventId)))
		.map((row) => ({ id: row.id, status: row.status, pending: row.status === "declined" && row.conflictAt?.getTime() === 0 }));
}

/**
 * Marks a booking that was `accepted` and is only declined until the room step has checked it again (see `declineBookingsStatement`):
 * its clash date is the epoch. A real decline has a date or none; a licence that has lapsed must keep those declined, and these it may re-check.
 */
export const PENDING_RECHECK = new Date(0);

/** The rooms an event is booked for, accepted or declined: what a save that names no rooms keeps. */
export async function bookedRoomIds(db: Db, eventId: string): Promise<string[]> {
	return (await db.select({ id: calendarResourceBookings.resourceId }).from(calendarResourceBookings).where(eq(calendarResourceBookings.eventId, eventId))).map((row) => row.id);
}

/** What an invitation's LOCATION says (spec F9 8.5): the event's own location, then the accepted rooms. */
export function invitationLocation(location: string, roomNames: string[]): string {
	return [location.trim(), roomNames.join(", ")].filter(Boolean).join("; ");
}

/**
 * The statement that goes in the same batch as any write that can change when an event happens: its bookings become `declined`
 * (fail closed) and the room step then books them again. If the process dies between the two, no booking stays `accepted` for a
 * time nobody checked. For an event with no rooms it matches nothing.
 */
export const declineBookingsStatement = (db: Db, eventId: string) => db.update(calendarResourceBookings).set({ status: "declined", conflictAt: PENDING_RECHECK }).where(and(eq(calendarResourceBookings.eventId, eventId), eq(calendarResourceBookings.status, "accepted")));

/**
 * The event is already saved at its new time, so a room check that cannot finish must not leave its bookings `accepted` for times
 * nobody checked: they are declined (fail closed). The next save of the event checks them again.
 */
async function declineUnchecked(db: Db, eventId: string): Promise<void> {
	try { await declineBookingsStatement(db, eventId); } catch (error) {
		console.error("Declining the rooms of an unchecked event failed", error);
	}
}

/**
 * Books the rooms (see `bookRooms`) and describes the outcome for the response and the invitation. A failure does not escape: the
 * event is saved, so the caller still audits, invites and answers; the rooms come back declined.
 */
export async function bookAndSummarize(db: Db, eventId: string, resourceIds: string[], options: { declined?: string[] } = {}): Promise<RoomsSummary> {
	let rooms: Awaited<ReturnType<typeof bookRooms>>["rooms"];
	try { ({ rooms } = await bookRooms(db, eventId, resourceIds, options)); } catch (error) {
		console.error("Booking rooms failed after the event was saved", error);
		await declineUnchecked(db, eventId);
		rooms = [...new Set(resourceIds)].map((resourceId) => ({ resourceId, status: "unconfirmed" as const, conflictAt: null, occurrences: [] }));
	}
	const names = new Map<string, string>();
	if (rooms.length) for (const row of await db.select({ id: calendarResources.id, name: calendarResources.name }).from(calendarResources).where(inArray(calendarResources.id, rooms.map((room) => room.resourceId)))) names.set(row.id, row.name);
	return {
		rooms: rooms.map((room) => ({ resourceId: room.resourceId, name: names.get(room.resourceId) ?? "", status: room.status, conflictAt: room.conflictAt?.toISOString() ?? null })),
		resourceConflicts: rooms.filter((room) => room.status === "declined" && room.occurrences.length).map((room) => ({ resourceId: room.resourceId, occurrences: room.occurrences })),
		acceptedNames: rooms.filter((room) => room.status === "accepted").map((room) => names.get(room.resourceId) ?? "").filter(Boolean),
	};
}

/** The response fields for an event with rooms; an event without any answers exactly as it did before rooms existed. */
export const roomResponse = (summary: RoomsSummary | null) => (summary && summary.rooms.length ? { rooms: summary.rooms, resourceConflicts: summary.resourceConflicts } : {});

/**
 * Re-checks the rooms of events changed somewhere other than the web editor (a phone's CalDAV write, the MCP update tool): a new
 * time or rule can now clash. Events with no rooms cost one read. The event is already saved, so a failure here is logged, never
 * thrown at the caller; the next save of the event re-checks it. `canBook` says whether the installation may book rooms (`roomsBookable(env)`).
 */
export async function rebookEvents(db: Db, eventIds: string[], canBook: () => Promise<boolean>): Promise<void> {
	for (const id of new Set(eventIds)) {
		try {
			const booked = await bookedRooms(db, id);
			if (!booked.length) continue;
			// Booking needs a Team licence (D-13). Without one a declined room stays declined, whichever path changed the event; only a
			// licence check is needed (and only then) when there is a declined room to decide about. If the check itself fails, so does the event's check.
			const declined = booked.filter((room) => room.status === "declined" && !room.pending).map((room) => room.id);
			const frozen = declined.length && !(await canBook()) ? declined : [];
			await bookRooms(db, id, booked.map((room) => room.id), { declined: frozen });
		} catch (error) {
			console.error("Room check after an event change failed", error);
			await declineUnchecked(db, id);
		}
	}
}

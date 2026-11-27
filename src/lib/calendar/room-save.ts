import { eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarResourceBookings, calendarResources } from "@/db/schema";
import { bookRooms } from "./room-booking";

type Db = ReturnType<typeof getDb>;

export type RoomState = { resourceId: string; name: string; status: "accepted" | "declined"; /** First clashing occurrence, ISO. */ conflictAt: string | null };
export type RoomsSummary = {
	rooms: RoomState[];
	/** Declined rooms with up to ten clashing dates each (D-8). */
	resourceConflicts: { resourceId: string; occurrences: string[] }[];
	/** Names of the rooms the guests' invitation lists (accepted ones only). */
	acceptedNames: string[];
};

/** The rooms an event is booked for, accepted or declined: what a save that names no rooms keeps. */
export async function bookedRoomIds(db: Db, eventId: string): Promise<string[]> {
	return (await db.select({ id: calendarResourceBookings.resourceId }).from(calendarResourceBookings).where(eq(calendarResourceBookings.eventId, eventId))).map((row) => row.id);
}

/** What an invitation's LOCATION says (spec F9 8.5): the event's own location, then the accepted rooms. */
export function invitationLocation(location: string, roomNames: string[]): string {
	return [location.trim(), roomNames.join(", ")].filter(Boolean).join("; ");
}

/** Books the rooms (see `bookRooms`) and describes the outcome for the response and the invitation. */
export async function bookAndSummarize(db: Db, eventId: string, resourceIds: string[]): Promise<RoomsSummary> {
	const { rooms } = await bookRooms(db, eventId, resourceIds);
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

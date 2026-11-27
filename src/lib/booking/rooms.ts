import { asc, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { resolveBookableRooms } from "@/lib/calendar/resources";
import { invitationLocation } from "@/lib/calendar/room-save";
import type { BookableRooms } from "@/lib/calendar/resources-types";
import { calendarResources } from "@/db/schema";
import { getLicenseEntitlements } from "@/lib/licenses/service";

export { MAX_BOOKING_ROOMS, parseBookingResourceIds } from "./resource-ids";

/**
 * Whether a booking page may use these rooms right now: a Team licence (D-13), and every room still exists and is on. A room that
 * is gone or turned off cannot be promised to a visitor, and silently dropping it would book them without the room the owner chose.
 */
export async function bookingRoomsUsable(env: CloudflareEnv, resourceIds: string[]): Promise<boolean> {
	const ids = [...new Set(resourceIds)];
	if (!ids.length) return true;
	if (!(await getLicenseEntitlements(env)).canShareMailboxes) return false;
	const rooms = await getDb(env).select({ id: calendarResources.id, disabled: calendarResources.disabled }).from(calendarResources).where(inArray(calendarResources.id, ids));
	return rooms.length === ids.length && rooms.every((room) => !room.disabled);
}

/**
 * The rooms an owner's request attaches (D-13): the same checks as an event save (known, on, at most five; a room newly added needs
 * the Team licence, one already attached stays whatever the licence says, and removing is always allowed). A request that names no
 * rooms keeps `booked`, so an older client that does not know the field cannot drop them.
 */
export async function resolveBookingRooms(db: Parameters<typeof resolveBookableRooms>[0], body: unknown, options: { booked: string[]; canBook: boolean }): Promise<BookableRooms> {
	const requested = body && typeof body === "object" && "resourceIds" in body ? (body as { resourceIds: unknown }).resourceIds : options.booked;
	return resolveBookableRooms(db, requested, options);
}

/** The location a visitor's confirmation shows: the event type's own, then the rooms they now hold (spec F9 8.5). Asked only after the booking succeeded. */
export async function locationWithRooms(env: CloudflareEnv, location: string, resourceIds: string[]): Promise<string> {
	if (!resourceIds.length) return location;
	// The booking is made: a failure to read the names must not turn it into an error page.
	try {
		const rooms = await getDb(env).select({ name: calendarResources.name }).from(calendarResources).where(inArray(calendarResources.id, resourceIds)).orderBy(asc(calendarResources.name));
		return invitationLocation(location, rooms.map((room) => room.name));
	} catch (error) {
		console.error("Reading the booked rooms' names failed", error);
		return location;
	}
}

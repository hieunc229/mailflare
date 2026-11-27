import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarResources } from "@/db/schema";
import { getLicenseEntitlements } from "@/lib/licenses/service";

/** Rooms per event type, the same limit as an event (spec F9 section 5). */
export const MAX_BOOKING_ROOMS = 5;

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

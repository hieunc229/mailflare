import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { bookingEvents, calendarResources } from "@/db/schema";
import { parseBookingResourceIds } from "@/lib/booking/resource-ids";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { calendarAccessError } from "@/lib/calendar/api-auth";
import { MAX_RESOURCES } from "@/lib/calendar/resources";
import { getLicenseEntitlements } from "@/lib/licenses/service";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The rooms a booking-page owner may choose from: the ones open to public booking pages (`available`), plus any room already attached to one
 * of the caller's own booking types, labelled for what it now is (`private`: closed to public pages, `off`: turned off) so it is not called
 * removed. Other rooms are not named at all. Names only: no administrator notes.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const denied = calendarAccessError(user);
	if (denied) return denied;
	const db = getDb(env);
	const mine = new Set((await db.select({ resourceIds: bookingEvents.resourceIds }).from(bookingEvents).where(eq(bookingEvents.userId, user.id))).flatMap((row) => parseBookingResourceIds(row.resourceIds) ?? []));
	const rows = await db.select({ id: calendarResources.id, name: calendarResources.name, kind: calendarResources.kind, capacity: calendarResources.capacity, location: calendarResources.location, disabled: calendarResources.disabled, publicBooking: calendarResources.publicBooking }).from(calendarResources).orderBy(asc(calendarResources.name)).limit(MAX_RESOURCES);
	const rooms = rows.filter((room) => (room.publicBooking && !room.disabled) || mine.has(room.id)).map(({ disabled, publicBooking, ...room }) => ({ ...room, state: disabled ? "off" : publicBooking ? "available" : "private" }));
	return NextResponse.json({ rooms, canBook: (await getLicenseEntitlements(env)).canShareMailboxes }, { headers: NO_STORE });
}

import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarResources } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { calendarAccessError } from "@/lib/calendar/api-auth";
import { MAX_RESOURCES } from "@/lib/calendar/resources";
import { getLicenseEntitlements } from "@/lib/licenses/service";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The rooms a booking-page owner may choose from, with what each can be used for: `available` rooms can be attached, `private` ones
 * are not open to public booking pages (an administrator's switch) and `off` ones are turned off. Every room is listed, so a room
 * already attached to an event type is labelled for what it is rather than "removed". Names only: no administrator notes.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const denied = calendarAccessError(user);
	if (denied) return denied;
	const rows = await getDb(env).select({ id: calendarResources.id, name: calendarResources.name, kind: calendarResources.kind, capacity: calendarResources.capacity, location: calendarResources.location, disabled: calendarResources.disabled, publicBooking: calendarResources.publicBooking }).from(calendarResources).orderBy(asc(calendarResources.name)).limit(MAX_RESOURCES);
	const rooms = rows.map(({ disabled, publicBooking, ...room }) => ({ ...room, state: disabled ? "off" : publicBooking ? "available" : "private" }));
	return NextResponse.json({ rooms, canBook: (await getLicenseEntitlements(env)).canShareMailboxes }, { headers: NO_STORE });
}

import { and, eq, isNull, ne, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents, calendarResourceBookings, users } from "@/db/schema";
import { roomsBookable } from "@/lib/calendar/room-licence";
import { declineBookingsStatement, rebookEvents } from "@/lib/calendar/room-save";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { parseTimeZoneUpdate } from "./utils";
import { getRequestTimeZone } from "@/lib/time/utils";

/** Events with rooms whose bookings one zone change re-checks (the rest keep what they had until their next save). */
const MAX_RECHECKED = 200;

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const input = await parseTimeZoneUpdate(request);
	if (!input) return NextResponse.json({ error: "Choose a valid timezone" }, { status: 400 });
	const db = getDb(env);
	// Legacy series have no recorded timezone. Freeze their current recurrence
	// before changing the account preference, so future instants do not move.
	const freeze = db.update(calendarEvents).set({ timeZone: getRequestTimeZone(request, user.timeZone) }).where(and(
		eq(calendarEvents.userId, user.id),
		isNull(calendarEvents.timeZone),
		ne(calendarEvents.repeat, "none"),
	));
	const setZone = db.update(users).set({ timeZone: input.timeZone }).where(eq(users.id, user.id));
	// Events with no zone of their own (repeating, or all-day) are expanded in the account's zone, so this moves them, and a room they
	// booked may now be taken at the new time: their bookings are declined in the same batch and checked again after it.
	const moving = (await db.select({ id: calendarEvents.id }).from(calendarEvents).innerJoin(calendarResourceBookings, eq(calendarResourceBookings.eventId, calendarEvents.id))
		.where(and(eq(calendarEvents.userId, user.id), isNull(calendarEvents.timeZone), or(ne(calendarEvents.repeat, "none"), eq(calendarEvents.allDay, true)))).limit(MAX_RECHECKED + 1)).map((row) => row.id);
	if (!moving.length) {
		await freeze;
		await setZone;
		return NextResponse.json({ timeZone: input.timeZone });
	}
	const ids = [...new Set(moving)].slice(0, MAX_RECHECKED);
	await db.batch([freeze, setZone, ...ids.map((id) => declineBookingsStatement(db, id))] as never);
	await rebookEvents(db, ids, roomsBookable(env));
	return NextResponse.json({ timeZone: input.timeZone });
}

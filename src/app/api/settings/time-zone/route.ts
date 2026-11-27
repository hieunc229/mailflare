import { and, eq, isNull, ne, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents, calendarResourceBookings, users } from "@/db/schema";
import { roomsBookable } from "@/lib/calendar/room-licence";
import { declineBookingsOfStatement, PENDING_RECHECK, rebookEvents } from "@/lib/calendar/room-save";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { parseTimeZoneUpdate } from "./utils";
import { getRequestTimeZone } from "@/lib/time/utils";

/** Events with rooms re-checked in the request that changes the zone; the rest wait declined (fail closed) until their next save. */
const RECHECKED_IN_REQUEST = 20;

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const input = await parseTimeZoneUpdate(request);
	if (!input) return NextResponse.json({ error: "Choose a valid timezone" }, { status: 400 });
	// The same zone again changes nothing: nothing is frozen, declined or checked.
	if (input.timeZone === (user.timeZone ?? null)) return NextResponse.json({ timeZone: input.timeZone });
	const db = getDb(env);
	// Legacy series have no recorded timezone. Freeze their current recurrence
	// before changing the account preference, so future instants do not move.
	const freeze = db.update(calendarEvents).set({ timeZone: getRequestTimeZone(request, user.timeZone) }).where(and(
		eq(calendarEvents.userId, user.id),
		isNull(calendarEvents.timeZone),
		ne(calendarEvents.repeat, "none"),
	));
	const setZone = db.update(users).set({ timeZone: input.timeZone }).where(eq(users.id, user.id));
	// The events that move are those read in the account's zone: an all-day event with no zone, and a repeating one with no zone only when the account
	// had none before (otherwise the freeze above keeps its instants). Their accepted bookings are declined in this batch by ONE statement that selects them
	// itself, first (before the freeze changes which events have no zone), and the room step books them again after it.
	const moving = db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(
		eq(calendarEvents.userId, user.id), isNull(calendarEvents.timeZone),
		user.timeZone ? eq(calendarEvents.allDay, true) : or(eq(calendarEvents.allDay, true), ne(calendarEvents.repeat, "none")),
	));
	await db.batch([declineBookingsOfStatement(db, moving), freeze, setZone] as never);
	// Re-check only a few here; any others stay declined and waiting, which fails closed, and are checked at their next save.
	const waiting = await db.selectDistinct({ id: calendarResourceBookings.eventId }).from(calendarResourceBookings).innerJoin(calendarEvents, eq(calendarEvents.id, calendarResourceBookings.eventId))
		.where(and(eq(calendarEvents.userId, user.id), eq(calendarResourceBookings.status, "declined"), eq(calendarResourceBookings.conflictAt, PENDING_RECHECK))).limit(RECHECKED_IN_REQUEST);
	if (waiting.length) await rebookEvents(db, waiting.map((row) => row.id), roomsBookable(env));
	return NextResponse.json({ timeZone: input.timeZone });
}

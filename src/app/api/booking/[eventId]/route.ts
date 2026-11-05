import { and, eq } from "drizzle-orm";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { bookingEvents } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { parseBookingEventInput } from "@/lib/booking/utils";
import { getEnv } from "@/lib/cloudflare";
import { calendarAccessError } from "@/lib/calendar/api-auth";
import type { BookingEventRouteContext } from "./types";
import { validBookingHostIds } from "@/lib/booking/hosts";
import { getLicenseEntitlements } from "@/lib/licenses/service";

export async function PATCH(request: Request, { params }: BookingEventRouteContext) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const denied = calendarAccessError(user);
	if (denied) return denied;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const input = parseBookingEventInput(await request.json().catch(() => null));
	if (!input) return NextResponse.json({ error: "Enter valid booking details and availability." }, { status: 400 });
	const { eventId } = await params;
	const db = getDb(env);
	const canManageHosts = user.role === "admin" && (await getLicenseEntitlements(env)).canShareMailboxes;
	const hostIds = await validBookingHostIds(db, user.id, input.hostIds, canManageHosts);
	if (!hostIds) return NextResponse.json({ error: "Choose users from the host list." }, { status: 400 });
	const [taken] = await db.select({ id: bookingEvents.id }).from(bookingEvents).where(and(eq(bookingEvents.userId, user.id), eq(bookingEvents.slug, input.slug))).limit(1);
	if (taken && taken.id !== eventId) return NextResponse.json({ error: "This event link is already in use." }, { status: 409 });
	try {
		const [event] = await db.update(bookingEvents).set({ ...input, hostIds: JSON.stringify(hostIds), weekdays: JSON.stringify(input.weekdays), timeRanges: JSON.stringify(input.timeRanges), updatedAt: new Date() }).where(and(eq(bookingEvents.id, eventId), eq(bookingEvents.userId, user.id))).returning();
		return event ? NextResponse.json({ event }) : NextResponse.json({ error: "Booking event not found" }, { status: 404 });
	} catch (error) {
		if (isUniqueConstraintError(error)) return NextResponse.json({ error: "This event link is already in use." }, { status: 409 });
		throw error;
	}
}

export async function DELETE(request: Request, { params }: BookingEventRouteContext) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const denied = calendarAccessError(user);
	if (denied) return denied;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { eventId } = await params;
	const [event] = await getDb(env).delete(bookingEvents).where(and(eq(bookingEvents.id, eventId), eq(bookingEvents.userId, user.id))).returning();
	return event ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Booking event not found" }, { status: 404 });
}

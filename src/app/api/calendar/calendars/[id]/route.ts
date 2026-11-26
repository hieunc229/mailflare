import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { calendarIdFrom } from "@/lib/calendar/calendar-id";
import { deleteCalendar, updateCalendar } from "@/lib/calendar/calendars";
import { calendarCollectionId } from "@/lib/dav/changes";
import { getCalendarAccess, roleAtLeast } from "@/lib/calendar/shares";
import type { CalendarInput } from "@/lib/calendar/calendars-types";
import { readJsonObject } from "@/lib/http/request";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { CalendarRouteParams } from "./types";


export async function PATCH(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await readJsonObject<CalendarInput>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const calendarId = calendarIdFrom((await params).id);
	const db = getDb(env);
	// The owner and a `manage` grantee may edit name, colour and description; everyone else without a role is told it is not there.
	const access = await getCalendarAccess(db, user, calendarId);
	if (!access || access.role === "freebusy") return NextResponse.json({ error: "Calendar not found" }, { status: 404 });
	if (!roleAtLeast(access.role, "manage")) return NextResponse.json({ error: "You cannot change this calendar" }, { status: 403 });
	const result = await updateCalendar(db, access.ownerId, calendarId, input);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	await createAuditLog(env, { actorUserId: user.id, targetUserId: access.ownerId, action: "calendar.updated", metadata: { calendarId, name: result.calendar.name } });
	return NextResponse.json({ calendar: { ...result.calendar, role: access.role, isDefault: calendarId === calendarCollectionId(user.id) } });
}

export async function DELETE(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await request.json().catch(() => null) as { confirm?: unknown } | null;
	if (input?.confirm !== true) return NextResponse.json({ error: "Confirm deleting this calendar and its events" }, { status: 400 });
	const calendarId = calendarIdFrom((await params).id);
	const db = getDb(env);
	const access = await getCalendarAccess(db, user, calendarId);
	if (!access || access.role === "freebusy") return NextResponse.json({ error: "Calendar not found" }, { status: 404 });
	if (access.role !== "owner") return NextResponse.json({ error: "Only the owner can delete a calendar" }, { status: 403 });
	const result = await deleteCalendar(db, user.id, calendarId);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, action: "calendar.deleted", metadata: { calendarId, name: result.name, eventCount: result.eventCount } });
	return NextResponse.json({ ok: true, deletedEvents: result.eventCount });
}

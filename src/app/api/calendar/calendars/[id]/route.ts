import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { deleteCalendar, updateCalendar } from "@/lib/calendar/calendars";
import type { CalendarInput } from "@/lib/calendar/calendars-types";
import { readJsonObject } from "@/lib/http/request";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { CalendarRouteParams } from "./types";

/** Calendar ids contain a colon (`cal:...`), which clients may send percent-encoded. */
function calendarIdFrom(raw: string): string {
	try { return decodeURIComponent(raw); } catch { return raw; }
}

export async function PATCH(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await readJsonObject<CalendarInput>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const calendarId = calendarIdFrom((await params).id);
	const result = await updateCalendar(getDb(env), user.id, calendarId, input);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, action: "calendar.updated", metadata: { calendarId, name: result.calendar.name } });
	return NextResponse.json({ calendar: result.calendar });
}

export async function DELETE(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await request.json().catch(() => null) as { confirm?: unknown } | null;
	if (input?.confirm !== true) return NextResponse.json({ error: "Confirm deleting this calendar and its events" }, { status: 400 });
	const calendarId = calendarIdFrom((await params).id);
	const result = await deleteCalendar(getDb(env), user.id, calendarId);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, action: "calendar.deleted", metadata: { calendarId, name: result.name, eventCount: result.eventCount } });
	return NextResponse.json({ ok: true, deletedEvents: result.eventCount });
}

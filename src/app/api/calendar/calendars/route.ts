import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { createCalendar } from "@/lib/calendar/calendars";
import { listVisibleCalendars } from "@/lib/calendar/shares";
import type { CalendarInput } from "@/lib/calendar/calendars-types";
import { readJsonObject } from "@/lib/http/request";
import { createAuditLog } from "@/lib/mailboxes/audit";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	return NextResponse.json({ calendars: await listVisibleCalendars(getDb(env), user) });
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await readJsonObject<CalendarInput>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const result = await createCalendar(getDb(env), user.id, input);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, action: "calendar.created", metadata: { calendarId: result.calendar.id, name: result.calendar.name } });
	return NextResponse.json({ calendar: result.calendar });
}

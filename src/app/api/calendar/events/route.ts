import { and, eq, gte, lt, ne, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { sendEmail } from "@/lib/email/send";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { DEFAULT_REPEAT_DAYS, normalizeCalendarRepeat, normalizeCalendarRepeatDays } from "@/lib/calendar/recurrence";
import type { CalendarEventInput } from "./types";
import { getRequestTimeZone, normalizeTimeZone } from "@/lib/time/utils";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const url = new URL(request.url);
	const start = new Date(url.searchParams.get("start") ?? Date.now());
	const end = new Date(url.searchParams.get("end") ?? start.getTime() + 31 * 86_400_000);
	const events = await getDb(env).select().from(calendarEvents).where(and(eq(calendarEvents.userId, user.id), lt(calendarEvents.startsAt, end), or(gte(calendarEvents.endsAt, start), ne(calendarEvents.repeat, "none")))).orderBy(calendarEvents.startsAt);
	return NextResponse.json({ events });
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await request.json() as CalendarEventInput;
	const startsAt = new Date(input.startsAt);
	const endsAt = new Date(input.endsAt);
	if (!input.title?.trim() || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return NextResponse.json({ error: "Enter a title and valid event times" }, { status: 400 });
	const repeat = normalizeCalendarRepeat(input.repeat);
	const repeatDays = repeat === "weekdays" ? normalizeCalendarRepeatDays(input.repeatDays ?? DEFAULT_REPEAT_DAYS) : [];
	if (repeat === "weekdays" && repeatDays.length === 0) return NextResponse.json({ error: "Choose at least one weekday" }, { status: 400 });
	const attendees = (input.attendees ?? []).map((email) => email.trim()).filter((email) => /^\S+@\S+\.\S+$/.test(email));
	if (attendees.length && input.mailboxId && !calendarKeyCanSendInvitations(key, input.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	const event = { id: newId("evt"), userId: user.id, mailboxId: input.mailboxId ?? null, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color), repeat, repeatDays: JSON.stringify(repeatDays), repeatAnchorDay: repeat === "monthly" && Number.isInteger(input.repeatAnchorDay) && input.repeatAnchorDay! >= 1 && input.repeatAnchorDay! <= 31 ? input.repeatAnchorDay : null, reminderMinutes: normalizeReminderMinutes(input.reminderMinutes), startsAt, endsAt };
	const savedEvent = { ...event, timeZone: input.timeZone ? normalizeTimeZone(input.timeZone) : getRequestTimeZone(request, user.timeZone) };
	await getDb(env).insert(calendarEvents).values(savedEvent);
	if (attendees.length && input.mailboxId) {
		const calendarFile = createCalendarInvitation({ ...event, uid: event.id });
		await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: input.mailboxId!, from: input.from ?? "", to, subject: `Invitation: ${event.title}`, text: event.description || `You are invited to ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: calendarFile }] })));
	}
	return NextResponse.json({ event: savedEvent });
}

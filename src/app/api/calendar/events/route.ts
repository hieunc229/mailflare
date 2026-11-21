import { and, eq, gte, inArray, lt, ne, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents, calendarOccurrenceResponses } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { sendEmail } from "@/lib/email/send";
import { sendToAttendees } from "@/lib/calendar/invite-delivery";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { DEFAULT_REPEAT_DAYS, normalizeCalendarRepeat, normalizeCalendarRepeatDays, normalizeRepeatInterval, normalizeRepeatWeek, normalizeRepeatWeekday } from "@/lib/calendar/recurrence";
import type { CalendarEventInput } from "./types";
import { getRequestTimeZone, normalizeTimeZone } from "@/lib/time/utils";
import { chunkIds } from "@/lib/calendar/chunks";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import { readJsonObject } from "@/lib/http/request";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const url = new URL(request.url);
	const start = new Date(url.searchParams.get("start") ?? Date.now());
	const end = new Date(url.searchParams.get("end") ?? start.getTime() + 31 * 86_400_000);
	const db = getDb(env);
	const events = await db.select().from(calendarEvents).where(and(eq(calendarEvents.userId, user.id), lt(calendarEvents.startsAt, end), or(gte(calendarEvents.endsAt, start), ne(calendarEvents.repeat, "none")))).orderBy(calendarEvents.startsAt);
	// Additive occurrence data for the expanders: moved/extra occurrences and per-occurrence guest replies.
	const overrides: Record<string, Array<{ occurrenceMs: number; startsAt: Date; endsAt: Date }>> = {};
	const occurrenceResponses: Record<string, Array<{ occurrenceMs: number; guest: string; status: string }>> = {};
	if (events.length) {
		const ids = events.map((event) => event.id);
		const overrideRows: Array<{ eventId: string; occurrenceMs: number; startsAt: Date; endsAt: Date }> = [];
		const responseRows: Array<{ eventId: string; occurrenceMs: number; guest: string; status: string }> = [];
		for (const chunk of chunkIds(ids)) {
			const [chunkOverrides, chunkResponses] = await Promise.all([
				db.select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk)),
				db.select().from(calendarOccurrenceResponses).where(inArray(calendarOccurrenceResponses.eventId, chunk)),
			]);
			overrideRows.push(...chunkOverrides);
			responseRows.push(...chunkResponses);
		}
		for (const row of overrideRows) (overrides[row.eventId] ??= []).push({ occurrenceMs: row.occurrenceMs, startsAt: row.startsAt, endsAt: row.endsAt });
		for (const row of responseRows) (occurrenceResponses[row.eventId] ??= []).push({ occurrenceMs: row.occurrenceMs, guest: row.guest, status: row.status });
	}
	return NextResponse.json({ events, overrides, occurrenceResponses });
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await readJsonObject<CalendarEventInput>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const startsAt = new Date(input.startsAt);
	const endsAt = new Date(input.endsAt);
	if (!input.title?.trim() || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return NextResponse.json({ error: "Enter a title and valid event times" }, { status: 400 });
	const repeat = normalizeCalendarRepeat(input.repeat);
	const repeatDays = repeat === "weekdays" ? normalizeCalendarRepeatDays(input.repeatDays ?? DEFAULT_REPEAT_DAYS) : [];
	if (repeat === "weekdays" && repeatDays.length === 0) return NextResponse.json({ error: "Choose at least one weekday" }, { status: 400 });
	const repeatInterval = repeat === "weekdays" ? 1 : normalizeRepeatInterval(input.repeatInterval);
	const repeatWeekday = normalizeRepeatWeekday(input.repeatWeekday);
	const repeatWeek = normalizeRepeatWeek(input.repeatWeek);
	if (repeat !== "monthly" && (repeatWeekday != null || repeatWeek != null)) return NextResponse.json({ error: "Weekday repeats are only valid for monthly events" }, { status: 400 });
	if (repeat === "monthly" && (repeatWeekday == null) !== (repeatWeek == null)) return NextResponse.json({ error: "Set both a weekday and a week for this repeat" }, { status: 400 });
	// A listed-days repeat steps day by day, so its interval is always 1.
	const attendees = (input.attendees ?? []).map((email) => email.trim()).filter((email) => /^\S+@\S+\.\S+$/.test(email));
	if (attendees.length && input.mailboxId && !calendarKeyCanSendInvitations(key, input.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	const event = { id: newId("evt"), userId: user.id, mailboxId: input.mailboxId ?? null, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color), repeat, repeatDays: JSON.stringify(repeatDays), repeatAnchorDay: repeat === "monthly" && Number.isInteger(input.repeatAnchorDay) && input.repeatAnchorDay! >= 1 && input.repeatAnchorDay! <= 31 ? input.repeatAnchorDay : null, repeatInterval, repeatWeekday, repeatWeek, eventSequence: 0, reminderMinutes: normalizeReminderMinutes(input.reminderMinutes), startsAt, endsAt };
	const savedEvent = { ...event, timeZone: input.timeZone ? normalizeTimeZone(input.timeZone) : getRequestTimeZone(request, user.timeZone) };
	await getDb(env).insert(calendarEvents).values(savedEvent);
	let inviteErrors: string[] = [];
	if (attendees.length && input.mailboxId) {
		const calendarFile = createCalendarInvitation({ title: event.title, description: event.description, location: event.location, startsAt, endsAt, uid: event.id, organizer: input.from || undefined, attendees, sequence: 0, reminderMinutes: event.reminderMinutes, repeat, repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: null, repeatInterval, repeatWeekday, repeatWeek, excludedOccurrences: [], overrides: [] });
		inviteErrors = await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: input.mailboxId!, from: input.from ?? "", to, subject: `Invitation: ${event.title}`, text: event.description || `You are invited to ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: calendarFile }] }));
	}
	return NextResponse.json(inviteErrors.length ? { event: savedEvent, inviteErrors } : { event: savedEvent });
}

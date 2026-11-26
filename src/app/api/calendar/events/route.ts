import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { sendEmail } from "@/lib/email/send";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { resolveRepeat } from "@/lib/calendar/repeat-fields";
import { EVENT_FLAGS_ERROR, resolveEventFlags } from "@/lib/calendar/event-flags";
import type { CalendarEventInput } from "./types";
import { getRequestTimeZone, normalizeTimeZone } from "@/lib/time/utils";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import { readJsonObject } from "@/lib/http/request";
import { calendarCollectionId } from "@/lib/dav/changes";
import { INVITE_REQUIRES_OWNER } from "@/lib/calendar/shares-errors";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { calendarExistsGuard, eventCalendarId } from "@/lib/calendar/calendars";
import { listVisibleEvents } from "@/lib/calendar/event-list";
import { resolveCalendarForWrite } from "@/lib/calendar/shares";
import { createAuditLog } from "@/lib/mailboxes/audit";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const url = new URL(request.url);
	const start = new Date(url.searchParams.get("start") ?? Date.now());
	const end = new Date(url.searchParams.get("end") ?? start.getTime() + 31 * 86_400_000);
	const requested = url.searchParams.getAll("calendarIds").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
	const events = await listVisibleEvents(getDb(env), user, { start, end }, requested);
	return NextResponse.json({ events });
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
	const repeatFields = resolveRepeat(null, input);
	if (!repeatFields) return NextResponse.json({ error: "Choose at least one weekday" }, { status: 400 });
	const flags = resolveEventFlags(null, input);
	if (!flags) return NextResponse.json({ error: EVENT_FLAGS_ERROR }, { status: 400 });
	const calendar = await resolveCalendarForWrite(getDb(env), user, input.calendarId);
	if (!calendar.ok) return NextResponse.json({ error: calendar.error }, { status: calendar.status });
	// Whoever is not the calendar's owner is a delegate: the row is the owner's (D-2), with no guests, mailbox or reminder of its own.
	const delegate = calendar.ownerId !== user.id;
	const attendees = (input.attendees ?? []).map((email) => email.trim()).filter((email) => /^\S+@\S+\.\S+$/.test(email));
	if (delegate && attendees.length) return NextResponse.json({ error: "Only the calendar's owner can invite guests to its events", code: INVITE_REQUIRES_OWNER }, { status: 403 });
	if (attendees.length && input.mailboxId && !calendarKeyCanSendInvitations(key, input.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	const event = { id: newId("evt"), userId: calendar.ownerId, mailboxId: delegate ? null : input.mailboxId ?? null, calendarId: calendar.calendarId ?? null, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color), repeat: repeatFields.repeat, repeatDays: repeatFields.repeatDays, repeatAnchorDay: repeatFields.repeatAnchorDay, reminderMinutes: delegate ? null : normalizeReminderMinutes(input.reminderMinutes), ...flags, startsAt, endsAt };
	const savedEvent = { ...event, timeZone: input.timeZone ? normalizeTimeZone(input.timeZone) : getRequestTimeZone(request, user.timeZone) };
	const db = getDb(env);
	if (typeof calendar.calendarId === "string") {
		// The calendar may be deleted between the check above and this write: the batch refuses to write into a calendar that is gone.
		try { await db.batch([...calendarExistsGuard(db, calendar.ownerId, calendar.calendarId), db.insert(calendarEvents).values(savedEvent)] as never); } catch (error) {
			if (isUniqueConstraintError(error)) return NextResponse.json({ error: "That calendar no longer exists" }, { status: 409 });
			throw error;
		}
	} else await db.insert(calendarEvents).values(savedEvent);
	if (delegate) await createAuditLog(env, { actorUserId: user.id, targetUserId: calendar.ownerId, action: "calendar.event_created_by_delegate", metadata: { calendarId: calendar.calendarId ?? calendarCollectionId(calendar.ownerId), eventId: event.id } });
	if (attendees.length && input.mailboxId) {
		const calendarFile = createCalendarInvitation({ ...event, uid: event.id, organizer: input.from || undefined, attendees });
		await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: input.mailboxId!, from: input.from ?? "", to, subject: `Invitation: ${event.title}`, text: event.description || `You are invited to ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: calendarFile }] })));
	}
	return NextResponse.json({ event: { ...savedEvent, calendarId: eventCalendarId(savedEvent) } });
}

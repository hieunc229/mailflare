import { inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents, calendarOccurrenceResponses } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { sendEmail } from "@/lib/email/send";
import { sendToAttendees } from "@/lib/calendar/invite-delivery";
import { assertInviteesAllowed } from "@/lib/deliverability/suppression";
import { SuppressedRecipientError, suppressedRecipientBody } from "@/lib/deliverability/suppression-utils";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { EVENT_FLAGS_ERROR, resolveEventFlags } from "@/lib/calendar/event-flags";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { DEFAULT_REPEAT_DAYS, normalizeCalendarRepeat, normalizeCalendarRepeatDays, normalizeRepeatInterval, normalizeRepeatWeek, normalizeRepeatWeekday } from "@/lib/calendar/recurrence";
import type { CalendarEventInput } from "./types";
import { getRequestTimeZone, normalizeTimeZone } from "@/lib/time/utils";
import { chunkIds } from "@/lib/calendar/chunks";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import { readJsonObject } from "@/lib/http/request";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { listRoomEvents, MAX_SCHEDULE_ROOMS, roomsByEvent } from "@/lib/calendar/room-schedule";
import { resolveBookableRooms } from "@/lib/calendar/resources";
import { bookAndSummarize, invitationLocation, roomResponse, type RoomsSummary } from "@/lib/calendar/room-save";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { calendarExistsGuard, eventCalendarId } from "@/lib/calendar/calendars";
import { listVisibleEvents } from "@/lib/calendar/event-list";
import { resolveCalendarForWrite } from "@/lib/calendar/shares";
import { INVITE_REQUIRES_OWNER } from "@/lib/calendar/shares-errors";
import { calendarCollectionId } from "@/lib/dav/changes";
import { createAuditLog } from "@/lib/mailboxes/audit";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const url = new URL(request.url);
	const start = new Date(url.searchParams.get("start") ?? Date.now());
	const end = new Date(url.searchParams.get("end") ?? start.getTime() + 31 * 86_400_000);
	const db = getDb(env);
	const requested = url.searchParams.getAll("calendarIds").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
	const roomIds = url.searchParams.getAll("resourceIds").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
	if (new Set(roomIds).size > MAX_SCHEDULE_ROOMS) return NextResponse.json({ error: `Ask for at most ${MAX_SCHEDULE_ROOMS} rooms at a time` }, { status: 400 });
	const visible = await listVisibleEvents(db, user, { start, end }, requested);
	// An event shows its rooms to whoever can read it in full; a redacted one hides them with the rest.
	// Rooms belong to the series: a moved occurrence (an override row) reports its master's.
	const seriesOf = (event: (typeof visible)[number]) => event.davObjectId ?? event.id;
	const booked = await roomsByEvent(db, [...new Set(visible.filter((event) => !(event as { redacted?: boolean }).redacted).map(seriesOf))]);
	const events = visible.map((event) => !(event as { redacted?: boolean }).redacted && booked.has(seriesOf(event)) ? { ...event, rooms: booked.get(seriesOf(event)) } : event);
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
	return NextResponse.json(roomIds.length ? { events, overrides, occurrenceResponses, roomEvents: await listRoomEvents(db, user, roomIds, { start, end }) } : { events, overrides, occurrenceResponses });
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
	const flags = resolveEventFlags(null, input);
	if (!flags) return NextResponse.json({ error: EVENT_FLAGS_ERROR }, { status: 400 });
	const calendar = await resolveCalendarForWrite(getDb(env), user, input.calendarId);
	if (!calendar.ok) return NextResponse.json({ error: calendar.error }, { status: calendar.status });
	// Rooms are checked before anything is written: a bad list or a lapsed licence saves nothing.
	let roomIds: string[] = [];
	if (input.resourceIds !== undefined) {
		const checked = await resolveBookableRooms(getDb(env), input.resourceIds, { booked: [], canBook: (await getLicenseEntitlements(env)).canShareMailboxes });
		if (!checked.ok) return NextResponse.json({ error: checked.error, ...(checked.code ? { code: checked.code } : {}) }, { status: checked.status });
		roomIds = checked.ids;
	}
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
	// Whoever is not the calendar's owner is a delegate: the row is the owner's (D-2), with no guests, mailbox or reminder of its own.
	const delegate = calendar.ownerId !== user.id;
	if (delegate && attendees.length) return NextResponse.json({ error: "Only the calendar's owner can invite guests to its events", code: INVITE_REQUIRES_OWNER }, { status: 403 });
	if (attendees.length && input.mailboxId && !calendarKeyCanSendInvitations(key, input.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	if (attendees.length && input.mailboxId) {
		// Before the event is stored: a refused invitation leaves nothing behind, so a retry cannot duplicate it.
		try {
			await assertInviteesAllowed(env, { userId: user.id, mailboxId: input.mailboxId, from: input.from ?? "", attendees });
		} catch (error) {
			if (error instanceof SuppressedRecipientError) return NextResponse.json(suppressedRecipientBody(error), { status: 422 });
			throw error;
		}
	}
	const event = { id: newId("evt"), userId: calendar.ownerId, mailboxId: delegate ? null : input.mailboxId ?? null, calendarId: calendar.calendarId ?? null, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color), repeat, repeatDays: JSON.stringify(repeatDays), repeatAnchorDay: repeat === "monthly" && Number.isInteger(input.repeatAnchorDay) && input.repeatAnchorDay! >= 1 && input.repeatAnchorDay! <= 31 ? input.repeatAnchorDay : null, repeatInterval, repeatWeekday, repeatWeek, eventSequence: 0, reminderMinutes: delegate ? null : normalizeReminderMinutes(input.reminderMinutes), ...flags, startsAt, endsAt };
	const savedEvent = { ...event, timeZone: input.timeZone ? normalizeTimeZone(input.timeZone) : getRequestTimeZone(request, user.timeZone) };
	const db = getDb(env);
	if (typeof calendar.calendarId === "string") {
		// The calendar may be deleted between the check above and this write: the batch refuses to write into a calendar that is gone.
		try { await db.batch([...calendarExistsGuard(db, calendar.ownerId, calendar.calendarId), db.insert(calendarEvents).values(savedEvent)] as never); } catch (error) {
			if (isUniqueConstraintError(error)) return NextResponse.json({ error: "That calendar no longer exists" }, { status: 409 });
			throw error;
		}
	} else await db.insert(calendarEvents).values(savedEvent);
	const rooms: RoomsSummary | null = roomIds.length ? await bookAndSummarize(db, event.id, roomIds) : null;
	let inviteErrors: string[] = [];
	if (attendees.length && input.mailboxId) {
		const calendarFile = createCalendarInvitation({ isPrivate: event.isPrivate, transparent: event.transparent, title: event.title, description: event.description, location: invitationLocation(event.location, rooms?.acceptedNames ?? []), startsAt, endsAt, uid: event.id, organizer: input.from || undefined, attendees, sequence: 0, reminderMinutes: event.reminderMinutes, repeat, repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: null, repeatInterval, repeatWeekday, repeatWeek, excludedOccurrences: [], overrides: [] });
		inviteErrors = await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: input.mailboxId!, from: input.from ?? "", to, subject: `Invitation: ${event.title}`, text: event.description || `You are invited to ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: calendarFile }] }));
	}
	if (delegate) await createAuditLog(env, { actorUserId: user.id, targetUserId: calendar.ownerId, action: "calendar.event_created_by_delegate", metadata: { calendarId: calendar.calendarId ?? calendarCollectionId(calendar.ownerId), eventId: event.id } });
	const responseEvent = { ...savedEvent, calendarId: eventCalendarId(savedEvent) };
	return NextResponse.json({ event: responseEvent, ...(inviteErrors.length ? { inviteErrors } : {}), ...roomResponse(rooms) });
}

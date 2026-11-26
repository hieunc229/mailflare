import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { sendEmail } from "@/lib/email/send";
import type { CalendarEventInput } from "../types";
import type { CalendarEventRouteParams } from "./types";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { EVENT_FLAGS_ERROR, resolveEventFlags } from "@/lib/calendar/event-flags";
import { parseCalendarOccurrenceId, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { CUSTOM_DAY_LOCKED, editedTimeZone, endLegacySeries, resolveRepeat, shiftCustomSeries } from "@/lib/calendar/repeat-fields";
import { limitRrule, rruleEndedBefore } from "@/lib/calendar/rrule";
import { deleteOverridesFrom, deleteSeriesRows, moveSeriesToCalendar, shiftOverrides, splitSeriesRows } from "@/lib/calendar/series-rows";
import { newId } from "@/lib/ids";
import { getRequestTimeZone } from "@/lib/time/utils";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import { readJsonObject } from "@/lib/http/request";
import { resolveEventCalendar } from "@/lib/calendar/calendars";

export async function PATCH(request: Request, { params }: CalendarEventRouteParams) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const { eventId } = await params;
	const occurrence = parseCalendarOccurrenceId(eventId);
	const input = await readJsonObject<CalendarEventInput>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const startsAt = new Date(input.startsAt);
	const endsAt = new Date(input.endsAt);
	const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : occurrence?.startsAt;
	if (!input.title?.trim() || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return NextResponse.json({ error: "Enter a title and valid event times" }, { status: 400 });
	if (effectiveFrom && Number.isNaN(effectiveFrom.getTime())) return NextResponse.json({ error: "Invalid repeat start" }, { status: 400 });
	const db = getDb(env);
	const [existing] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, occurrence?.seriesId ?? eventId), eq(calendarEvents.userId, user.id))).limit(1);
	if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 });
	const calendar = await resolveEventCalendar(db, user.id, input.calendarId);
	if (!calendar.ok) return NextResponse.json({ error: calendar.error }, { status: calendar.status });
	// Undefined keeps the calendar; otherwise the whole series moves, so compare against where it is now.
	const moveTo = calendar.calendarId !== undefined && calendar.calendarId !== (existing.calendarId ?? null) ? calendar.calendarId : undefined;
	const timeZone = editedTimeZone(existing, input.repeat, input.timeZone ?? existing.timeZone ?? getRequestTimeZone(request, user.timeZone));
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	if (existing.repeat !== "none" && effectiveFrom && existing.repeatUntil && effectiveFrom >= existing.repeatUntil) return NextResponse.json({ error: "No future occurrences remain" }, { status: 404 });
	// A custom series has no repeat_until: its end lives in the rule, so ask the rule.
	if (existing.rrule && effectiveFrom && rruleEndedBefore(existing.rrule, existing.startsAt, existing.timeZone, effectiveFrom)) return NextResponse.json({ error: "No future occurrences remain" }, { status: 404 });
	const flags = resolveEventFlags(existing, input);
	if (!flags) return NextResponse.json({ error: EVENT_FLAGS_ERROR }, { status: 400 });
	const attendees = (input.attendees ?? []).map((email) => email.trim()).filter((email) => /^\S+@\S+\.\S+$/.test(email));
	if (attendees.length && existing.mailboxId && input.from && !calendarKeyCanSendInvitations(key, existing.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	if (input.moveOccurrenceToPast) {
		if (!occurrence || existing.repeat === "none" || startsAt >= new Date()) return NextResponse.json({ error: "Choose a past time for this occurrence" }, { status: 400 });
		const excluded = parseExcludedOccurrences(existing.excludedOccurrences);
		if (excluded.includes(occurrence.startsAt.getTime())) return NextResponse.json({ error: "Occurrence already moved" }, { status: 409 });
		const now = new Date();
		const moved = { ...existing, id: newId("evt"), title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color ?? existing.color), ...flags, ...(moveTo !== undefined ? { calendarId: moveTo } : {}), repeat: "none" as const, repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: null, excludedOccurrences: "[]",
			// A moved occurrence of a DAV series stays part of that resource as an override row; otherwise it is a plain one-off.
			davObjectId: existing.davObjectId === existing.id ? existing.id : null, recurrenceId: existing.davObjectId === existing.id ? occurrence.startsAt : null, startsAt, endsAt, createdAt: now, updatedAt: now };
		await db.insert(calendarEvents).values(moved);
		await db.update(calendarEvents).set({ excludedOccurrences: JSON.stringify([...excluded, occurrence.startsAt.getTime()]), updatedAt: now }).where(eq(calendarEvents.id, existing.id));
		if (moveTo !== undefined) await moveSeriesToCalendar(db, user.id, existing.id, moveTo);
		if (attendees.length && existing.mailboxId && input.from) { const file = createCalendarInvitation({ ...moved, uid: moved.id, organizer: input.from, attendees }); await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${moved.title}`, text: moved.description || `This event has been updated: ${moved.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] }))); }
		return NextResponse.json({ ok: true });
	}
	const repeatFields = resolveRepeat(existing, input);
	if (!repeatFields) return NextResponse.json({ error: "Choose at least one weekday" }, { status: 400 });
	const event = { ...existing, timeZone, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color ?? existing.color), ...repeatFields, reminderMinutes: input.reminderMinutes === undefined ? existing.reminderMinutes : normalizeReminderMinutes(input.reminderMinutes), lastRemindedStart: null, ...flags, startsAt, endsAt };
	// A kept custom rule is not editable here, so the series may change time of day only: its exclusions and moved occurrences move with it.
	const shifted = event.repeat === "custom" ? shiftCustomSeries(existing, startsAt, timeZone) : null;
	if (event.repeat === "custom" && !shifted) return NextResponse.json({ error: CUSTOM_DAY_LOCKED }, { status: 409 });
	// A custom rule that is kept is edited as a whole series: "this and following" cannot split a rule Mailflare cannot express.
	const splitAt = existing.repeat !== "none" && event.repeat !== "custom" ? effectiveFrom : null;
	if (splitAt && splitAt > existing.startsAt) {
		const now = new Date();
		// The new series is a Mailflare event of its own, never part of the DAV resource it was split from.
		await splitSeriesRows(db, user.id, existing, splitAt, { ...event, id: newId("evt"), davObjectId: null, recurrenceId: null, ...(moveTo !== undefined ? { calendarId: moveTo } : {}), createdAt: now, updatedAt: now }, existing.rrule ? { rrule: limitRrule(existing.rrule, splitAt, existing.startsAt, existing.timeZone, existing.allDay), updatedAt: now } : { repeatUntil: splitAt, updatedAt: now });
	} else {
		await db.update(calendarEvents).set({ title: event.title, description: event.description, location: event.location, attendees: event.attendees, color: event.color, repeat: event.repeat, repeatDays: event.repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: event.repeatUntil, rrule: event.rrule, ...(shifted ? { excludedOccurrences: shifted.excludedOccurrences } : {}), reminderMinutes: event.reminderMinutes, isPrivate: event.isPrivate, transparent: event.transparent, lastRemindedStart: null, timeZone, startsAt, endsAt, updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
		if (shifted?.moved) await shiftOverrides(db, user.id, existing.id, shifted.shift);
	}
	// After the edit above, so the event is written in one place and then the master and its overrides move together.
	if (moveTo !== undefined) await moveSeriesToCalendar(db, user.id, existing.id, moveTo);
	if (attendees.length && existing.mailboxId && input.from) { const file = createCalendarInvitation({ ...event, uid: existing.id, organizer: input.from, attendees }); await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${event.title}`, text: event.description || `This event has been updated: ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] }))); }
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: CalendarEventRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const { eventId } = await params;
	const occurrence = parseCalendarOccurrenceId(eventId);
	const input = await request.json().catch(() => ({})) as CalendarEventInput;
	const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : occurrence?.startsAt;
	if (effectiveFrom && Number.isNaN(effectiveFrom.getTime())) return NextResponse.json({ error: "Invalid repeat start" }, { status: 400 });
	const db = getDb(env);
	const [existing] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, occurrence?.seriesId ?? eventId), eq(calendarEvents.userId, user.id))).limit(1);
	if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 });
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	if (existing.repeat !== "none" && effectiveFrom && effectiveFrom > existing.startsAt) {
		await db.update(calendarEvents).set(existing.rrule ? { rrule: limitRrule(existing.rrule, effectiveFrom, existing.startsAt, existing.timeZone, existing.allDay), updatedAt: new Date() } : { repeatUntil: endLegacySeries(existing.repeatUntil, effectiveFrom), updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
		// Moved occurrences of a DAV series that fall in the part being deleted go with it.
		if (existing.davObjectId === existing.id) await deleteOverridesFrom(db, user.id, existing.id, effectiveFrom);
	} else await deleteSeriesRows(db, user.id, existing.id);
	return NextResponse.json({ ok: true });
}

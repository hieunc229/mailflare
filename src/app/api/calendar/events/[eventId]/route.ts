import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { sendEmail } from "@/lib/email/send";
import { sendToAttendees } from "@/lib/calendar/invite-delivery";
import type { CalendarEventInput } from "../types";
import type { CalendarEventRouteParams } from "./types";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { normalizeRepeatInterval, normalizeRepeatWeek, normalizeRepeatWeekday, parseCalendarOccurrenceId, parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { CUSTOM_DAY_LOCKED, editedTimeZone, endLegacySeries, resolveRepeat, shiftCustomSeries } from "@/lib/calendar/repeat-fields";
import { limitRrule, rruleEndedBefore } from "@/lib/calendar/rrule";
import { deleteOverridesFrom, deleteSeriesRows, shiftOverrides, splitSeriesRows } from "@/lib/calendar/series-rows";
import { newId } from "@/lib/ids";
import { getRequestTimeZone } from "@/lib/time/utils";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import { buildSplitAnnouncement } from "@/lib/calendar/split-announcement";
import { readJsonObject } from "@/lib/http/request";

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
	// An invitation received by mail is never re-announced to its guests from here.
	const isInboundInvite = existing.responseStatus != null || existing.inviteMessageId != null;
	const timeZone = editedTimeZone(existing, input.repeat, input.timeZone ?? existing.timeZone ?? getRequestTimeZone(request, user.timeZone));
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	if (existing.repeat !== "none" && effectiveFrom && existing.repeatUntil && effectiveFrom >= existing.repeatUntil) return NextResponse.json({ error: "No future occurrences remain" }, { status: 404 });
	// A custom series has no repeat_until: its end lives in the rule, so ask the rule.
	if (existing.rrule && effectiveFrom && rruleEndedBefore(existing.rrule, existing.startsAt, existing.timeZone, effectiveFrom)) return NextResponse.json({ error: "No future occurrences remain" }, { status: 404 });
	const attendees = (input.attendees ?? []).map((email) => email.trim()).filter((email) => /^\S+@\S+\.\S+$/.test(email));
	if (attendees.length && existing.mailboxId && input.from && !calendarKeyCanSendInvitations(key, existing.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	let inviteErrors: string[] = [];
	if (input.moveOccurrenceToPast) {
		if (!occurrence || existing.repeat === "none" || startsAt >= new Date()) return NextResponse.json({ error: "Choose a past time for this occurrence" }, { status: 400 });
		const excluded = parseExcludedOccurrences(existing.excludedOccurrences);
		if (excluded.includes(occurrence.startsAt.getTime())) return NextResponse.json({ error: "Occurrence already moved" }, { status: 409 });
		const now = new Date();
		const moved = { ...existing, id: newId("evt"), eventSequence: 0, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color ?? existing.color), repeat: "none" as const, repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null, excludedOccurrences: "[]", rrule: null,
			// A moved occurrence of a DAV series stays part of that resource as an override row; otherwise it is a plain one-off.
			davObjectId: existing.davObjectId === existing.id ? existing.id : null, recurrenceId: existing.davObjectId === existing.id ? occurrence.startsAt : null, startsAt, endsAt, createdAt: now, updatedAt: now };
		const newExcluded = [...excluded, occurrence.startsAt.getTime()];
		// Guests track revisions per UID, so the series row moves to the sequence this update carries.
		const seriesSequence = (existing.eventSequence ?? 0) + 1;
		await db.insert(calendarEvents).values(moved);
		await db.update(calendarEvents).set({ excludedOccurrences: JSON.stringify(newExcluded), eventSequence: seriesSequence, updatedAt: now }).where(eq(calendarEvents.id, existing.id));
		if (attendees.length && existing.mailboxId && input.from && !isInboundInvite) {
			const movedFile = createCalendarInvitation({ title: moved.title, description: moved.description, location: moved.location, startsAt, endsAt, uid: moved.id, organizer: input.from, attendees, sequence: 0, reminderMinutes: moved.reminderMinutes, repeat: "none", repeatDays: [], repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null, excludedOccurrences: [], overrides: [] });
			// The series keeps its UID: tell guests it dropped this occurrence, with the same repeat/override context a PATCH resend carries.
			const seriesOverrides = (await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id))).map((override) => ({ recurrenceId: new Date(override.occurrenceMs), startsAt: override.startsAt, endsAt: override.endsAt }));
			const seriesFile = createCalendarInvitation({ title: existing.title, description: existing.description, location: existing.location, startsAt: existing.startsAt, endsAt: existing.endsAt, uid: existing.id, organizer: input.from, attendees, sequence: seriesSequence, reminderMinutes: existing.reminderMinutes, repeat: existing.repeat, rrule: existing.rrule, repeatDays: parseCalendarRepeatDays(existing.repeatDays), repeatAnchorDay: existing.repeatAnchorDay, repeatUntil: existing.repeatUntil, repeatInterval: existing.repeat === "weekdays" ? 1 : normalizeRepeatInterval(existing.repeatInterval), repeatWeekday: existing.repeatWeekday, repeatWeek: existing.repeatWeek, excludedOccurrences: newExcluded, overrides: seriesOverrides });
			inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${moved.title}`, text: moved.description || `This event has been updated: ${moved.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: movedFile }] })));
			inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${existing.title}`, text: existing.description || `This event has been updated: ${existing.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: seriesFile }] })));
		}
		return NextResponse.json(inviteErrors.length ? { ok: true, inviteErrors: [...new Set(inviteErrors)] } : { ok: true });
	}
	const repeatFields = resolveRepeat(existing, input);
	if (!repeatFields) return NextResponse.json({ error: "Choose at least one weekday" }, { status: 400 });
	const repeat = repeatFields.repeat;
	const repeatDays = parseCalendarRepeatDays(repeatFields.repeatDays);
	const repeatInterval = repeat === "weekdays" || repeat === "custom" ? 1 : (input.repeatInterval !== undefined ? normalizeRepeatInterval(input.repeatInterval) : normalizeRepeatInterval(existing.repeatInterval));
	// A listed-days repeat steps day by day, so its interval is always 1.
	let repeatWeekday = input.repeatWeekday !== undefined ? normalizeRepeatWeekday(input.repeatWeekday) : normalizeRepeatWeekday(existing.repeatWeekday);
	let repeatWeek = input.repeatWeek !== undefined ? normalizeRepeatWeek(input.repeatWeek) : normalizeRepeatWeek(existing.repeatWeek);
	if (repeat !== "monthly") {
		if ((input.repeatWeekday !== undefined && normalizeRepeatWeekday(input.repeatWeekday) != null) || (input.repeatWeek !== undefined && normalizeRepeatWeek(input.repeatWeek) != null)) return NextResponse.json({ error: "Weekday repeats are only valid for monthly events" }, { status: 400 });
		repeatWeekday = null;
		repeatWeek = null;
	} else if ((repeatWeekday == null) !== (repeatWeek == null)) return NextResponse.json({ error: "Set both a weekday and a week for this repeat" }, { status: 400 });
	const nextSequence = (existing.eventSequence ?? 0) + 1;
	const event = { ...existing, timeZone, eventSequence: nextSequence, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: JSON.stringify(attendees), color: normalizeCalendarColor(input.color ?? existing.color), ...repeatFields, repeatInterval, repeatWeekday, repeatWeek, reminderMinutes: input.reminderMinutes === undefined ? existing.reminderMinutes : normalizeReminderMinutes(input.reminderMinutes), lastRemindedStart: null, startsAt, endsAt };
	// A kept custom rule is not editable here, so the series may change time of day only: its exclusions and moved occurrences move with it.
	const shifted = event.repeat === "custom" ? shiftCustomSeries(existing, startsAt, timeZone) : null;
	if (event.repeat === "custom" && !shifted) return NextResponse.json({ error: CUSTOM_DAY_LOCKED }, { status: 409 });
	// A custom rule that is kept is edited as a whole series: "this and following" cannot split a rule Mailflare cannot express.
	const splitAt = existing.repeat !== "none" && event.repeat !== "custom" ? effectiveFrom : null;
	if (splitAt && splitAt > existing.startsAt) {
		// The fork continues the series at and after the split; an older start would overlap the truncated original.
		if (startsAt < splitAt) return NextResponse.json({ error: "The new series must start at or after the split point" }, { status: 400 });
		const now = new Date();
		const forkId = newId("evt");
		// The new series is a Mailflare event of its own, never part of the DAV resource it was split from.
		await splitSeriesRows(db, user.id, existing, splitAt, { ...event, id: forkId, eventSequence: 0, davObjectId: null, recurrenceId: null, createdAt: now, updatedAt: now }, existing.rrule ? { rrule: limitRrule(existing.rrule, splitAt, existing.startsAt, existing.timeZone, existing.allDay), eventSequence: nextSequence, updatedAt: now } : { repeatUntil: splitAt, eventSequence: nextSequence, updatedAt: now });
		// Overrides at or after the split belong to the fork; earlier ones stay on the truncated original.
		const stored = await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id));
		for (const override of stored) {
			if (override.occurrenceMs >= splitAt.getTime()) await db.update(calendarEventOverrides).set({ eventId: forkId, updatedAt: new Date() }).where(and(eq(calendarEventOverrides.eventId, existing.id), eq(calendarEventOverrides.occurrenceMs, override.occurrenceMs)));
		}
		if (attendees.length && existing.mailboxId && input.from && !isInboundInvite) {
			const toOverrides = (rows: typeof stored) => rows.map((override) => ({ recurrenceId: new Date(override.occurrenceMs), startsAt: override.startsAt, endsAt: override.endsAt }));
			const { truncationFile, forkFile } = buildSplitAnnouncement({
				original: {
					uid: existing.id, title: existing.title, description: existing.description, location: existing.location,
					startsAt: existing.startsAt, endsAt: existing.endsAt,
					repeat: existing.repeat, rrule: existing.rrule ? limitRrule(existing.rrule, splitAt, existing.startsAt, existing.timeZone, existing.allDay) : null, repeatDays: parseCalendarRepeatDays(existing.repeatDays), repeatAnchorDay: existing.repeatAnchorDay,
					repeatUntil: existing.rrule ? null : splitAt, repeatInterval: existing.repeat === "weekdays" ? 1 : normalizeRepeatInterval(existing.repeatInterval),
					repeatWeekday: existing.repeatWeekday, repeatWeek: existing.repeatWeek,
					reminderMinutes: existing.reminderMinutes, excludedOccurrences: parseExcludedOccurrences(existing.excludedOccurrences),
					overrides: toOverrides(await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id))),
					sequence: nextSequence,
				},
				fork: {
					uid: forkId, title: event.title, description: event.description, location: event.location,
					startsAt: event.startsAt, endsAt: event.endsAt,
					repeat: event.repeat, rrule: event.rrule, repeatDays, repeatAnchorDay: event.repeatAnchorDay ?? null,
					repeatUntil: event.repeatUntil, repeatInterval: event.repeatInterval,
					repeatWeekday: event.repeatWeekday, repeatWeek: event.repeatWeek,
					reminderMinutes: event.reminderMinutes, excludedOccurrences: parseExcludedOccurrences(event.excludedOccurrences),
					overrides: toOverrides(await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, forkId))),
					sequence: 0,
				},
				organizer: input.from, attendees,
			});
			inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${existing.title}`, text: existing.description || `This event has been updated: ${existing.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: truncationFile }] })));
			inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Invitation: ${event.title}`, text: event.description || `You are invited to ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: forkFile }] })));
		}
		return NextResponse.json(inviteErrors.length ? { ok: true, inviteErrors: [...new Set(inviteErrors)] } : { ok: true });
	}
	await db.update(calendarEvents).set({ title: event.title, description: event.description, location: event.location, attendees: event.attendees, color: event.color, repeat: event.repeat, repeatDays: event.repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatInterval: event.repeatInterval, repeatWeekday: event.repeatWeekday, repeatWeek: event.repeatWeek, repeatUntil: event.repeatUntil, rrule: event.rrule, ...(shifted ? { excludedOccurrences: shifted.excludedOccurrences } : {}), eventSequence: nextSequence, reminderMinutes: event.reminderMinutes, lastRemindedStart: null, timeZone, startsAt, endsAt, updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
	if (shifted?.moved) await shiftOverrides(db, user.id, existing.id, shifted.shift);
	if (attendees.length && existing.mailboxId && input.from && !isInboundInvite) {
		const overrides = (await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id))).map((override) => ({ recurrenceId: new Date(override.occurrenceMs), startsAt: override.startsAt, endsAt: override.endsAt }));
		const file = createCalendarInvitation({ title: event.title, description: event.description, location: event.location, startsAt: event.startsAt, endsAt: event.endsAt, uid: existing.id, organizer: input.from, attendees, sequence: nextSequence, reminderMinutes: event.reminderMinutes, repeat: event.repeat, rrule: event.rrule, repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: event.repeatUntil, repeatInterval: event.repeatInterval, repeatWeekday: event.repeatWeekday, repeatWeek: event.repeatWeek, excludedOccurrences: parseExcludedOccurrences(event.excludedOccurrences), overrides });
		inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${event.title}`, text: event.description || `This event has been updated: ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] })));
	}
	return NextResponse.json(inviteErrors.length ? { ok: true, inviteErrors: [...new Set(inviteErrors)] } : { ok: true });
}

export async function DELETE(request: Request, { params }: CalendarEventRouteParams) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
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
	// An invitation received by mail is never announced to its guests from here; cancelling one only removes the row.
	const isInboundInvite = existing.responseStatus != null || existing.inviteMessageId != null;
	if (existing.mailboxId && input.from && !calendarKeyCanSendInvitations(key, existing.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	if (existing.repeat !== "none" && effectiveFrom && effectiveFrom > existing.startsAt) {
		await db.update(calendarEvents).set(existing.rrule ? { rrule: limitRrule(existing.rrule, effectiveFrom, existing.startsAt, existing.timeZone, existing.allDay), updatedAt: new Date() } : { repeatUntil: endLegacySeries(existing.repeatUntil, effectiveFrom), updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
		// Moved occurrences of a DAV series that fall in the part being deleted go with it.
		if (existing.davObjectId === existing.id) await deleteOverridesFrom(db, user.id, existing.id, effectiveFrom);
		return NextResponse.json({ ok: true });
	}
	await deleteSeriesRows(db, user.id, existing.id);
	if (!isInboundInvite && existing.mailboxId && input.from) {
		let attendees: string[] = [];
		try { attendees = (JSON.parse(existing.attendees || "[]") as string[]).filter((address) => /^\S+@\S+\.\S+$/.test(address)); } catch { attendees = []; }
		if (attendees.length) {
			const file = createCalendarInvitation({ title: existing.title, description: existing.description, location: existing.location, startsAt: existing.startsAt, endsAt: existing.endsAt, uid: existing.id, method: "CANCEL", organizer: input.from, attendees, sequence: (existing.eventSequence ?? 0) + 1, reminderMinutes: null, repeat: "none", repeatDays: [], repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null, excludedOccurrences: [], overrides: [] });
			await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Cancelled: ${existing.title}`, text: `This event has been cancelled: ${existing.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] })));
		}
	}
	return NextResponse.json({ ok: true });
}

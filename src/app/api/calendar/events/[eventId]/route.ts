import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents, davCollections } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { sendEmail } from "@/lib/email/send";
import { sendToAttendees } from "@/lib/calendar/invite-delivery";
import type { CalendarEventInput } from "../types";
import type { CalendarEventRouteParams } from "./types";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { normalizeReminderMinutes } from "@/lib/calendar/reminder-utils";
import { EVENT_FLAGS_ERROR, resolveEventFlags } from "@/lib/calendar/event-flags";
import { normalizeRepeatInterval, normalizeRepeatWeek, normalizeRepeatWeekday, parseCalendarOccurrenceId, parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { CUSTOM_DAY_LOCKED, editedTimeZone, endLegacySeries, resolveRepeat, shiftCustomSeries } from "@/lib/calendar/repeat-fields";
import { limitRrule, rruleEndedBefore } from "@/lib/calendar/rrule";
import { deleteOverridesFrom, deleteSeriesRows, moveSeriesStatements, shiftOverrides, splitSeriesRows, splitSeriesStatements } from "@/lib/calendar/series-rows";
import { newId } from "@/lib/ids";
import { getRequestTimeZone } from "@/lib/time/utils";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import { buildSplitAnnouncement } from "@/lib/calendar/split-announcement";
import { readJsonObject } from "@/lib/http/request";
import { calendarExistsGuard } from "@/lib/calendar/calendars";
import { getEventAccess, resolveCalendarForWrite, roleAtLeast } from "@/lib/calendar/shares";
import { EVENT_ID_EXISTS, INVITE_REQUIRES_OWNER } from "@/lib/calendar/shares-errors";
import { calendarCollectionId } from "@/lib/dav/changes";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { SessionUser } from "@/lib/auth/types";
import { isUniqueConstraintError } from "@/lib/database-errors";

type Db = ReturnType<typeof getDb>;
type EventRow = typeof calendarEvents.$inferSelect;

/**
 * The event a request names, with the actor's role on its calendar (the one check every write goes through). An id the actor
 * cannot see, or that is not there, is the same 404; a calendar they can read but not change is 403. The row is looked up by
 * id alone: the role, never the owner column, decides.
 */
async function loadEditableEvent(db: Db, user: { id: string }, id: string): Promise<{ existing: EventRow } | { response: NextResponse }> {
	const [existing] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
	const role = existing ? await getEventAccess(db, user, existing) : null;
	if (!existing || !role || role === "freebusy") return { response: NextResponse.json({ error: "Event not found" }, { status: 404 }) };
	if (!roleAtLeast(role, "edit")) return { response: NextResponse.json({ error: "You can only view this calendar" }, { status: 403 }) };
	return { existing };
}

/** The guests of a stored event, through the same filter a request's list goes through, so a value the filter drops (imported by a phone) cannot make the two differ. */
const GUEST_ADDRESS = /^\S+@\S+\.\S+$/;
/** The guests an invitation lists, as a comparable set. */
const guestSet = (list: string[]) => [...new Set(list.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort().join(",");
function storedGuests(raw: string | null): string[] {
	try { const parsed: unknown = JSON.parse(raw || "[]"); return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && GUEST_ADDRESS.test(entry.trim())) : []; } catch { return []; }
}

/** `calendarId` is where the event went (null: the owner's default); undefined when it did not move. */
const auditDelegate = (env: CloudflareEnv, user: Pick<SessionUser, "id">, existing: EventRow, action: string, calendarId: string | null | undefined) =>
	createAuditLog(env, { actorUserId: user.id, targetUserId: existing.userId, action, metadata: { calendarId: (calendarId === undefined ? existing.calendarId : calendarId) ?? calendarCollectionId(existing.userId), eventId: existing.id } });

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
	const loaded = await loadEditableEvent(db, user, occurrence?.seriesId ?? eventId);
	if ("response" in loaded) return loaded.response;
	const { existing } = loaded;
	// A delegate (an editor or manager acting on someone else's calendar) writes the owner's rows, never their own (D-2).
	const ownerId = existing.userId;
	const delegate = ownerId !== user.id;
	const calendar = await resolveCalendarForWrite(db, user, input.calendarId, { ownerId, calendarId: existing.calendarId });
	if (!calendar.ok) return NextResponse.json({ error: calendar.error }, { status: calendar.status });
	// Undefined keeps the calendar; otherwise the whole series moves, so compare against where it is now.
	const moveTo = calendar.calendarId !== undefined && calendar.calendarId !== (existing.calendarId ?? null) ? calendar.calendarId : undefined;
	// Writes that put rows into another calendar run as one batch that first checks the calendar still exists (a competing delete refuses it with 409).
	const guard = typeof moveTo === "string" ? calendarExistsGuard(db, ownerId, moveTo) : [];
	const batched = async (statements: unknown[]): Promise<NextResponse | null> => {
		try { await db.batch([...guard, ...statements] as never); return null; } catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			// The calendar guard and the stored resource's unique (collection, UID) and (collection, name) keys fail the same way: say which it was.
			const [still] = typeof moveTo === "string" ? await db.select({ id: davCollections.id }).from(davCollections).where(and(eq(davCollections.id, moveTo), eq(davCollections.userId, ownerId))).limit(1) : [];
			if (!still) return NextResponse.json({ error: "That calendar no longer exists" }, { status: 409 });
			return NextResponse.json({ error: "An event with the same ID already exists in that calendar", code: EVENT_ID_EXISTS }, { status: 409 });
		}
	};
	// An invitation received by mail is never re-announced to its guests from here.
	// A delegate sends nothing either: v1 invites are the owner's alone.
	const isInboundInvite = delegate || existing.responseStatus != null || existing.inviteMessageId != null;
	const timeZone = editedTimeZone(existing, input.repeat, input.timeZone ?? existing.timeZone ?? getRequestTimeZone(request, user.timeZone));
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	if (existing.repeat !== "none" && effectiveFrom && existing.repeatUntil && effectiveFrom >= existing.repeatUntil) return NextResponse.json({ error: "No future occurrences remain" }, { status: 404 });
	// A custom series has no repeat_until: its end lives in the rule, so ask the rule.
	if (existing.rrule && effectiveFrom && rruleEndedBefore(existing.rrule, existing.startsAt, existing.timeZone, effectiveFrom)) return NextResponse.json({ error: "No future occurrences remain" }, { status: 404 });
	const flags = resolveEventFlags(existing, input);
	if (!flags) return NextResponse.json({ error: EVENT_FLAGS_ERROR }, { status: 400 });
	const requestedGuests = (input.attendees ?? []).map((email) => email.trim()).filter((email) => /^\S+@\S+\.\S+$/.test(email));
	// v1: only the owner invites. A delegate may save an event with its guest list as it is, never change it, and sends nothing.
	if (delegate && guestSet(requestedGuests) !== guestSet(storedGuests(existing.attendees))) return NextResponse.json({ error: "Only the calendar's owner can change who is invited", code: INVITE_REQUIRES_OWNER }, { status: 403 });
	// A delegate's save keeps the stored list byte for byte: nothing is re-serialised, filtered or sent.
	const attendees = delegate ? storedGuests(existing.attendees) : requestedGuests;
	const keptGuests = delegate ? existing.attendees : JSON.stringify(attendees);
	if (!delegate && attendees.length && existing.mailboxId && input.from && !calendarKeyCanSendInvitations(key, existing.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	let inviteErrors: string[] = [];
	if (input.moveOccurrenceToPast) {
		if (!occurrence || existing.repeat === "none" || startsAt >= new Date()) return NextResponse.json({ error: "Choose a past time for this occurrence" }, { status: 400 });
		const excluded = parseExcludedOccurrences(existing.excludedOccurrences);
		if (excluded.includes(occurrence.startsAt.getTime())) return NextResponse.json({ error: "Occurrence already moved" }, { status: 409 });
		const now = new Date();
		const moved = { ...existing, id: newId("evt"), eventSequence: 0, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: keptGuests, color: normalizeCalendarColor(input.color ?? existing.color), ...flags, ...(moveTo !== undefined ? { calendarId: moveTo } : {}), repeat: "none" as const, repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null, excludedOccurrences: "[]", rrule: null,
			// A moved occurrence of a DAV series stays part of that resource as an override row; otherwise it is a plain one-off.
			davObjectId: existing.davObjectId === existing.id ? existing.id : null, recurrenceId: existing.davObjectId === existing.id ? occurrence.startsAt : null, startsAt, endsAt, createdAt: now, updatedAt: now };
		const newExcluded = [...excluded, occurrence.startsAt.getTime()];
		// Guests track revisions per UID, so the series row moves to the sequence this update carries.
		const seriesSequence = (existing.eventSequence ?? 0) + 1;
		const insertMoved = db.insert(calendarEvents).values(moved);
		const excludeOriginal = db.update(calendarEvents).set({ excludedOccurrences: JSON.stringify(newExcluded), eventSequence: seriesSequence, updatedAt: now }).where(eq(calendarEvents.id, existing.id));
		if (moveTo !== undefined) {
			const refused = await batched([insertMoved, excludeOriginal, ...moveSeriesStatements(db, ownerId, existing.id, moveTo)]);
			if (refused) return refused;
		} else { await insertMoved; await excludeOriginal; }
		if (attendees.length && existing.mailboxId && input.from && !isInboundInvite) {
			const movedFile = createCalendarInvitation({ isPrivate: moved.isPrivate, transparent: moved.transparent, title: moved.title, description: moved.description, location: moved.location, startsAt, endsAt, uid: moved.id, organizer: input.from, attendees, sequence: 0, reminderMinutes: moved.reminderMinutes, repeat: "none", repeatDays: [], repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null, excludedOccurrences: [], overrides: [] });
			// The series keeps its UID: tell guests it dropped this occurrence, with the same repeat/override context a PATCH resend carries.
			const seriesOverrides = (await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id))).map((override) => ({ recurrenceId: new Date(override.occurrenceMs), startsAt: override.startsAt, endsAt: override.endsAt }));
			const seriesFile = createCalendarInvitation({ isPrivate: existing.isPrivate, transparent: existing.transparent, title: existing.title, description: existing.description, location: existing.location, startsAt: existing.startsAt, endsAt: existing.endsAt, uid: existing.id, organizer: input.from, attendees, sequence: seriesSequence, reminderMinutes: existing.reminderMinutes, repeat: existing.repeat, rrule: existing.rrule, repeatDays: parseCalendarRepeatDays(existing.repeatDays), repeatAnchorDay: existing.repeatAnchorDay, repeatUntil: existing.repeatUntil, repeatInterval: existing.repeat === "weekdays" ? 1 : normalizeRepeatInterval(existing.repeatInterval), repeatWeekday: existing.repeatWeekday, repeatWeek: existing.repeatWeek, excludedOccurrences: newExcluded, overrides: seriesOverrides });
			inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${moved.title}`, text: moved.description || `This event has been updated: ${moved.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: movedFile }] })));
			inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${existing.title}`, text: existing.description || `This event has been updated: ${existing.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: seriesFile }] })));
		}
		if (delegate) await auditDelegate(env, user, existing, "calendar.event_updated_by_delegate", moveTo);
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
	const event = { ...existing, timeZone, eventSequence: nextSequence, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: keptGuests, color: normalizeCalendarColor(input.color ?? existing.color), ...repeatFields, repeatInterval, repeatWeekday, repeatWeek, reminderMinutes: delegate || input.reminderMinutes === undefined ? existing.reminderMinutes : normalizeReminderMinutes(input.reminderMinutes), lastRemindedStart: null, ...flags, startsAt, endsAt };
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
		const fresh = { ...event, id: forkId, eventSequence: 0, davObjectId: null, recurrenceId: null, ...(moveTo !== undefined ? { calendarId: moveTo } : {}), createdAt: now, updatedAt: now };
		const endPatch = existing.rrule ? { rrule: limitRrule(existing.rrule, splitAt, existing.startsAt, existing.timeZone, existing.allDay), eventSequence: nextSequence, updatedAt: now } : { repeatUntil: splitAt, eventSequence: nextSequence, updatedAt: now };
		if (moveTo !== undefined) {
			const refused = await batched([...splitSeriesStatements(db, ownerId, existing, splitAt, fresh, endPatch), ...moveSeriesStatements(db, ownerId, existing.id, moveTo)]);
			if (refused) return refused;
		} else await splitSeriesRows(db, ownerId, existing, splitAt, fresh, endPatch);
		// Overrides at or after the split belong to the fork; earlier ones stay on the truncated original.
		const stored = await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id));
		for (const override of stored) {
			if (override.occurrenceMs >= splitAt.getTime()) await db.update(calendarEventOverrides).set({ eventId: forkId, updatedAt: new Date() }).where(and(eq(calendarEventOverrides.eventId, existing.id), eq(calendarEventOverrides.occurrenceMs, override.occurrenceMs)));
		}
		if (attendees.length && existing.mailboxId && input.from && !isInboundInvite) {
			const toOverrides = (rows: typeof stored) => rows.map((override) => ({ recurrenceId: new Date(override.occurrenceMs), startsAt: override.startsAt, endsAt: override.endsAt }));
			const { truncationFile, forkFile } = buildSplitAnnouncement({
				original: {
					uid: existing.id, isPrivate: existing.isPrivate, transparent: existing.transparent, title: existing.title, description: existing.description, location: existing.location,
					startsAt: existing.startsAt, endsAt: existing.endsAt,
					repeat: existing.repeat, rrule: existing.rrule ? limitRrule(existing.rrule, splitAt, existing.startsAt, existing.timeZone, existing.allDay) : null, repeatDays: parseCalendarRepeatDays(existing.repeatDays), repeatAnchorDay: existing.repeatAnchorDay,
					repeatUntil: existing.rrule ? null : splitAt, repeatInterval: existing.repeat === "weekdays" ? 1 : normalizeRepeatInterval(existing.repeatInterval),
					repeatWeekday: existing.repeatWeekday, repeatWeek: existing.repeatWeek,
					reminderMinutes: existing.reminderMinutes, excludedOccurrences: parseExcludedOccurrences(existing.excludedOccurrences),
					overrides: toOverrides(await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id))),
					sequence: nextSequence,
				},
				fork: {
					uid: forkId, isPrivate: event.isPrivate, transparent: event.transparent, title: event.title, description: event.description, location: event.location,
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
		if (delegate) await auditDelegate(env, user, existing, "calendar.event_updated_by_delegate", moveTo);
		return NextResponse.json(inviteErrors.length ? { ok: true, inviteErrors: [...new Set(inviteErrors)] } : { ok: true });
	}
	const edit = db.update(calendarEvents).set({ title: event.title, description: event.description, location: event.location, attendees: event.attendees, color: event.color, repeat: event.repeat, repeatDays: event.repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatInterval: event.repeatInterval, repeatWeekday: event.repeatWeekday, repeatWeek: event.repeatWeek, repeatUntil: event.repeatUntil, rrule: event.rrule, ...(shifted ? { excludedOccurrences: shifted.excludedOccurrences } : {}), eventSequence: nextSequence, reminderMinutes: event.reminderMinutes, isPrivate: event.isPrivate, transparent: event.transparent, lastRemindedStart: null, timeZone, startsAt, endsAt, updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
	// The edit and the move to another calendar succeed or fail together.
	// Privacy belongs to the series: the moved occurrences carry the same flag, written in the same batch so no reader sees them apart.
	const propagate = existing.davObjectId === existing.id && flags.isPrivate !== existing.isPrivate
		? [db.update(calendarEvents).set({ isPrivate: flags.isPrivate }).where(and(eq(calendarEvents.userId, ownerId), eq(calendarEvents.davObjectId, existing.id), ne(calendarEvents.id, existing.id)))]
		: [];
	if (moveTo !== undefined || propagate.length) {
		const refused = await batched([edit, ...propagate, ...(moveTo !== undefined ? moveSeriesStatements(db, ownerId, existing.id, moveTo) : [])]);
		if (refused) return refused;
	} else await edit;
	if (shifted?.moved) await shiftOverrides(db, ownerId, existing.id, shifted.shift);
	if (attendees.length && existing.mailboxId && input.from && !isInboundInvite) {
		const overrides = (await db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, existing.id))).map((override) => ({ recurrenceId: new Date(override.occurrenceMs), startsAt: override.startsAt, endsAt: override.endsAt }));
		const file = createCalendarInvitation({ isPrivate: event.isPrivate, transparent: event.transparent, title: event.title, description: event.description, location: event.location, startsAt: event.startsAt, endsAt: event.endsAt, uid: existing.id, organizer: input.from, attendees, sequence: nextSequence, reminderMinutes: event.reminderMinutes, repeat: event.repeat, rrule: event.rrule, repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: event.repeatUntil, repeatInterval: event.repeatInterval, repeatWeekday: event.repeatWeekday, repeatWeek: event.repeatWeek, excludedOccurrences: parseExcludedOccurrences(event.excludedOccurrences), overrides });
		inviteErrors.push(...await sendToAttendees(attendees, (to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${event.title}`, text: event.description || `This event has been updated: ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] })));
	}
	if (delegate) await auditDelegate(env, user, existing, "calendar.event_updated_by_delegate", moveTo);
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
	const loaded = await loadEditableEvent(db, user, occurrence?.seriesId ?? eventId);
	if ("response" in loaded) return loaded.response;
	const { existing } = loaded;
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	// An invitation received by mail is never announced to its guests from here; cancelling one only removes the row.
	const delegate = existing.userId !== user.id;
	const isInboundInvite = delegate || existing.responseStatus != null || existing.inviteMessageId != null;
	if (!delegate && existing.mailboxId && input.from && !calendarKeyCanSendInvitations(key, existing.mailboxId)) return NextResponse.json({ error: "Sending invitations requires mail send permission for this mailbox" }, { status: 403 });
	if (existing.repeat !== "none" && effectiveFrom && effectiveFrom > existing.startsAt) {
		await db.update(calendarEvents).set(existing.rrule ? { rrule: limitRrule(existing.rrule, effectiveFrom, existing.startsAt, existing.timeZone, existing.allDay), updatedAt: new Date() } : { repeatUntil: endLegacySeries(existing.repeatUntil, effectiveFrom), updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
		// Moved occurrences of a DAV series that fall in the part being deleted go with it.
		if (existing.davObjectId === existing.id) await deleteOverridesFrom(db, existing.userId, existing.id, effectiveFrom);
		if (delegate) await auditDelegate(env, user, existing, "calendar.event_deleted_by_delegate", undefined);
		return NextResponse.json({ ok: true });
	}
	await deleteSeriesRows(db, existing.userId, existing.id);
	if (!isInboundInvite && existing.mailboxId && input.from) {
		let attendees: string[] = [];
		try { attendees = (JSON.parse(existing.attendees || "[]") as string[]).filter((address) => /^\S+@\S+\.\S+$/.test(address)); } catch { attendees = []; }
		if (attendees.length) {
			const file = createCalendarInvitation({ isPrivate: existing.isPrivate, transparent: existing.transparent, title: existing.title, description: existing.description, location: existing.location, startsAt: existing.startsAt, endsAt: existing.endsAt, uid: existing.id, method: "CANCEL", organizer: input.from, attendees, sequence: (existing.eventSequence ?? 0) + 1, reminderMinutes: null, repeat: "none", repeatDays: [], repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null, excludedOccurrences: [], overrides: [] });
			await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Cancelled: ${existing.title}`, text: `This event has been cancelled: ${existing.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] })));
		}
	}
	if (delegate) await auditDelegate(env, user, existing, "calendar.event_deleted_by_delegate", undefined);
	return NextResponse.json({ ok: true });
}

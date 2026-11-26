import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents, davCollections } from "@/db/schema";
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
import { deleteOverridesFrom, deleteSeriesRows, moveSeriesStatements, shiftOverrides, splitSeriesStatements } from "@/lib/calendar/series-rows";
import { newId } from "@/lib/ids";
import { getRequestTimeZone } from "@/lib/time/utils";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
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

/** The guests an invitation lists, as a comparable set. */
const guestSet = (list: string[]) => [...new Set(list.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort().join(",");
/** The guests of a stored event, through the same filter a request's list goes through, so a value the filter drops (imported by a phone) cannot make the two differ. */
const GUEST_ADDRESS = /^\S+@\S+\.\S+$/;
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
	// A moved occurrence is a row of its own but part of its series: a move is the series' move, by the master's id, from the master's calendar.
	const seriesId = existing.davObjectId && existing.davObjectId !== existing.id ? existing.davObjectId : existing.id;
	const head = seriesId === existing.id ? existing : (await db.select().from(calendarEvents).where(eq(calendarEvents.id, seriesId)).limit(1))[0] ?? existing;
	if (head !== existing && !roleAtLeast(await getEventAccess(db, user, head), "edit")) return NextResponse.json({ error: "You can only view this calendar" }, { status: 403 });
	const calendar = await resolveCalendarForWrite(db, user, input.calendarId, { ownerId, calendarId: head.calendarId });
	if (!calendar.ok) return NextResponse.json({ error: calendar.error }, { status: calendar.status });
	// Undefined keeps the calendar; otherwise the whole series moves, so compare against where it is now.
	const moveTo = calendar.calendarId !== undefined && calendar.calendarId !== (head.calendarId ?? null) ? calendar.calendarId : undefined;
	// Writes that put rows into another calendar run as one batch that first checks the calendar still exists (a competing delete refuses it with 409).
	// A write that puts rows into a named calendar (the one it moves to, or the one it is already in) first checks that the calendar is still there.
	const guardedCalendar = moveTo !== undefined ? moveTo : existing.calendarId;
	const guard = typeof guardedCalendar === "string" ? calendarExistsGuard(db, ownerId, guardedCalendar) : [];
	const batched = async (statements: unknown[]): Promise<NextResponse | null> => {
		try { await db.batch([...guard, ...statements] as never); return null; } catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			// The calendar guard and the stored resource's unique (collection, UID) and (collection, name) keys fail the same way: say which it was.
			const [still] = typeof guardedCalendar === "string" ? await db.select({ id: davCollections.id }).from(davCollections).where(and(eq(davCollections.id, guardedCalendar), eq(davCollections.userId, ownerId))).limit(1) : [];
			if (!still) return NextResponse.json({ error: "That calendar no longer exists" }, { status: 409 });
			return NextResponse.json({ error: "An event with the same ID already exists in that calendar", code: EVENT_ID_EXISTS }, { status: 409 });
		}
	};
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
	if (input.moveOccurrenceToPast) {
		if (!occurrence || existing.repeat === "none" || startsAt >= new Date()) return NextResponse.json({ error: "Choose a past time for this occurrence" }, { status: 400 });
		const excluded = parseExcludedOccurrences(existing.excludedOccurrences);
		if (excluded.includes(occurrence.startsAt.getTime())) return NextResponse.json({ error: "Occurrence already moved" }, { status: 409 });
		const now = new Date();
		const moved = { ...existing, id: newId("evt"), title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: keptGuests, color: normalizeCalendarColor(input.color ?? existing.color), ...flags, ...(moveTo !== undefined ? { calendarId: moveTo } : {}), repeat: "none" as const, repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: null, excludedOccurrences: "[]",
			// A moved occurrence of a DAV series stays part of that resource as an override row; otherwise it is a plain one-off.
			davObjectId: existing.davObjectId === existing.id ? existing.id : null, recurrenceId: existing.davObjectId === existing.id ? occurrence.startsAt : null, startsAt, endsAt, createdAt: now, updatedAt: now };
		const insertMoved = db.insert(calendarEvents).values(moved);
		const excludeOriginal = db.update(calendarEvents).set({ excludedOccurrences: JSON.stringify([...excluded, occurrence.startsAt.getTime()]), updatedAt: now }).where(eq(calendarEvents.id, existing.id));
		if (moveTo !== undefined) {
			const refused = await batched([insertMoved, excludeOriginal, ...moveSeriesStatements(db, ownerId, head.id, moveTo)]);
			if (refused) return refused;
		} else {
			const refused = await batched([insertMoved, excludeOriginal]);
			if (refused) return refused;
		}
		if (!delegate && attendees.length && existing.mailboxId && input.from) { const file = createCalendarInvitation({ ...moved, uid: moved.id, organizer: input.from, attendees }); await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${moved.title}`, text: moved.description || `This event has been updated: ${moved.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] }))); }
		if (delegate) await auditDelegate(env, user, existing, "calendar.event_updated_by_delegate", moveTo);
		return NextResponse.json({ ok: true });
	}
	const repeatFields = resolveRepeat(existing, input);
	if (!repeatFields) return NextResponse.json({ error: "Choose at least one weekday" }, { status: 400 });
	const event = { ...existing, timeZone, title: input.title.trim(), description: input.description?.trim() ?? "", location: input.location?.trim() ?? "", attendees: keptGuests, color: normalizeCalendarColor(input.color ?? existing.color), ...repeatFields, reminderMinutes: delegate || input.reminderMinutes === undefined ? existing.reminderMinutes : normalizeReminderMinutes(input.reminderMinutes), lastRemindedStart: null, ...flags, startsAt, endsAt };
	// A kept custom rule is not editable here, so the series may change time of day only: its exclusions and moved occurrences move with it.
	const shifted = event.repeat === "custom" ? shiftCustomSeries(existing, startsAt, timeZone) : null;
	if (event.repeat === "custom" && !shifted) return NextResponse.json({ error: CUSTOM_DAY_LOCKED }, { status: 409 });
	// A custom rule that is kept is edited as a whole series: "this and following" cannot split a rule Mailflare cannot express.
	const splitAt = existing.repeat !== "none" && event.repeat !== "custom" ? effectiveFrom : null;
	if (splitAt && splitAt > existing.startsAt) {
		const now = new Date();
		// The new series is a Mailflare event of its own, never part of the DAV resource it was split from.
		const fresh = { ...event, id: newId("evt"), davObjectId: null, recurrenceId: null, ...(moveTo !== undefined ? { calendarId: moveTo } : {}), createdAt: now, updatedAt: now };
		const endPatch = existing.rrule ? { rrule: limitRrule(existing.rrule, splitAt, existing.startsAt, existing.timeZone, existing.allDay), updatedAt: now } : { repeatUntil: splitAt, updatedAt: now };
		if (moveTo !== undefined) {
			const refused = await batched([...splitSeriesStatements(db, ownerId, existing, splitAt, fresh, endPatch), ...moveSeriesStatements(db, ownerId, head.id, moveTo)]);
			if (refused) return refused;
		} else {
			const refused = await batched(splitSeriesStatements(db, ownerId, existing, splitAt, fresh, endPatch));
			if (refused) return refused;
		}
	} else {
		const edit = db.update(calendarEvents).set({ title: event.title, description: event.description, location: event.location, attendees: event.attendees, color: event.color, repeat: event.repeat, repeatDays: event.repeatDays, repeatAnchorDay: event.repeatAnchorDay, repeatUntil: event.repeatUntil, rrule: event.rrule, ...(shifted ? { excludedOccurrences: shifted.excludedOccurrences } : {}), reminderMinutes: event.reminderMinutes, isPrivate: event.isPrivate, transparent: event.transparent, lastRemindedStart: null, timeZone, startsAt, endsAt, updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
		// Privacy belongs to the series: the moved occurrences carry the same flag, written in the same batch so no reader sees them apart.
		const propagate = existing.davObjectId === existing.id && flags.isPrivate !== existing.isPrivate
			? [db.update(calendarEvents).set({ isPrivate: flags.isPrivate }).where(and(eq(calendarEvents.userId, ownerId), eq(calendarEvents.davObjectId, existing.id), ne(calendarEvents.id, existing.id)))]
			: [];
		// The edit and the move to another calendar succeed or fail together.
		if (moveTo !== undefined || propagate.length) {
			const refused = await batched([edit, ...propagate, ...(moveTo !== undefined ? moveSeriesStatements(db, ownerId, head.id, moveTo) : [])]);
			if (refused) return refused;
		} else await edit;
		if (shifted?.moved) await shiftOverrides(db, ownerId, existing.id, shifted.shift);
	}
	if (delegate) await auditDelegate(env, user, existing, "calendar.event_updated_by_delegate", moveTo);
	if (!delegate && attendees.length && existing.mailboxId && input.from) { const file = createCalendarInvitation({ ...event, uid: existing.id, organizer: input.from, attendees }); await Promise.all(attendees.map((to) => sendEmail(env, { userId: user.id, mailboxId: existing.mailboxId!, from: input.from!, to, subject: `Updated invitation: ${event.title}`, text: event.description || `This event has been updated: ${event.title}.`, attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: file }] }))); }
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
	const loaded = await loadEditableEvent(db, user, occurrence?.seriesId ?? eventId);
	if ("response" in loaded) return loaded.response;
	const { existing } = loaded;
	if (occurrence && (existing.repeat === "none" || occurrence.startsAt < existing.startsAt || (existing.repeatUntil && occurrence.startsAt >= existing.repeatUntil))) return NextResponse.json({ error: "Occurrence not found" }, { status: 404 });
	if (existing.repeat !== "none" && effectiveFrom && effectiveFrom > existing.startsAt) {
		await db.update(calendarEvents).set(existing.rrule ? { rrule: limitRrule(existing.rrule, effectiveFrom, existing.startsAt, existing.timeZone, existing.allDay), updatedAt: new Date() } : { repeatUntil: endLegacySeries(existing.repeatUntil, effectiveFrom), updatedAt: new Date() }).where(eq(calendarEvents.id, existing.id));
		// Moved occurrences of a DAV series that fall in the part being deleted go with it.
		if (existing.davObjectId === existing.id) await deleteOverridesFrom(db, existing.userId, existing.id, effectiveFrom);
	} else await deleteSeriesRows(db, existing.userId, existing.id);
	if (existing.userId !== user.id) await auditDelegate(env, user, existing, "calendar.event_deleted_by_delegate", undefined);
	return NextResponse.json({ ok: true });
}

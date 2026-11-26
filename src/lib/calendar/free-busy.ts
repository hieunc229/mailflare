import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, davCalendarObjects } from "@/db/schema";
import { inviteEventId } from "./invite-id";
import { expandEvent } from "./rrule";
import { isBusyEvent } from "./visibility";

/** People per request and the longest window (spec F9 section 5, D-9). */
export const MAX_FREE_BUSY_IDS = 50;
export const MAX_FREE_BUSY_DAYS = 62;
/** People per statement: far under D1's 100 bound parameters with the three range conditions. */
const USER_CHUNK = 40;
/** Occurrences read per series in one window; a daily series needs 63. */
const MAX_OCCURRENCES = 2000;
/**
 * Work one request may spend expanding series, counted as one per series plus one per occurrence found, shared equally by the
 * people asked about (one alone has all of it). A person who spends their share gets their whole window as busy, not free: a
 * request that cannot be answered exactly never answers "free". Someone else's heavy calendar costs the others nothing.
 */
export const MAX_EXPANSION_BUDGET = 20_000;
const DAY = 86_400_000;

export type BusyInterval = [startMs: number, endMs: number];
/** Rooms and equipment are CS-7; until they exist `resourceIds` is accepted and ignored. */
export type FreeBusyTargets = {
	userIds: string[];
	resourceIds?: string[];
	/** An event being edited: it, its moved occurrences and every guest's copy of its invitation are left out, so it does not clash with itself. The caller must have checked the right to edit it. */
	excludeEventId?: string;
	/** Start (ms) of the one occurrence being edited: only that occurrence, and the moved row that replaced it, is left out; the rest of the series counts. */
	excludeOccurrence?: number;
	/**
	 * Also look up the UID a CalDAV client stored for that event and leave out copies carrying it. Only for the event's owner: for
	 * anyone else the stored UID is never read, so it cannot be probed. Invitations Mailflare sends always carry `<id>@mailflare`.
	 */
	excludeStoredUid?: boolean;
};

/** Sorts, then joins intervals that overlap or touch; empty ones are dropped. */
export function mergeBusy(intervals: BusyInterval[]): BusyInterval[] {
	const merged: BusyInterval[] = [];
	for (const [start, end] of [...intervals].filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/**
 * The one answer to "when is this person busy" (D-9): the editor, the publish URL and CalDAV all read it, so they cannot disagree.
 * Callers decide who may see whom (`viewableFreeBusyUsers`); this only turns events into intervals. Every calendar a person owns
 * counts (a row's user is its calendar's owner, D-2). Events marked free, invitations not yet accepted, declined and cancelled
 * ones do not (D-6); private events do, as bare intervals. A series is expanded with its exclusions, and a moved occurrence is a
 * row of its own, so it is busy at its new time only. A series too heavy to expand makes the whole window busy: unknown is never free.
 * Everyone asked for gets an entry (empty when free). At most 50 people and 62 days.
 */
export async function busyIntervals(env: CloudflareEnv, targets: FreeBusyTargets, start: Date, end: Date): Promise<Map<string, BusyInterval[]>> {
	const from = start.getTime();
	const to = end.getTime();
	const db = getDb(env);
	const ids = [...new Set(targets.userIds)];
	if (ids.length > MAX_FREE_BUSY_IDS) throw new RangeError(`Free/busy covers at most ${MAX_FREE_BUSY_IDS} people at a time`);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError("Choose a start before the end");
	if (to - from > MAX_FREE_BUSY_DAYS * DAY) throw new RangeError(`Free/busy covers at most ${MAX_FREE_BUSY_DAYS} days at a time`);
	// The event being edited and each guest's copy of its invitation, which carries UID `<id>@mailflare` (and the CalDAV client's own UID when the owner asks).
	const excluded = new Set<string>();
	if (targets.excludeEventId) {
		const uids = [`${targets.excludeEventId}@mailflare`];
		if (targets.excludeStoredUid) {
			const [stored] = await db.select({ uid: davCalendarObjects.uid }).from(davCalendarObjects).where(eq(davCalendarObjects.id, targets.excludeEventId)).limit(1);
			if (stored?.uid && !uids.includes(stored.uid)) uids.push(stored.uid);
		}
		excluded.add(targets.excludeEventId);
		for (const id of ids) for (const uid of uids) excluded.add(await inviteEventId(id, uid));
	}
	const share = Math.floor(MAX_EXPANSION_BUDGET / Math.max(ids.length, 1));
	const spent = new Map<string, number>();
	const collected = new Map<string, BusyInterval[]>(ids.map((id) => [id, []]));
	for (let index = 0; index < ids.length; index += USER_CHUNK) {
		const rows = await db.select({
			id: calendarEvents.id, davObjectId: calendarEvents.davObjectId, userId: calendarEvents.userId, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, timeZone: calendarEvents.timeZone, repeat: calendarEvents.repeat, rrule: calendarEvents.rrule,
			repeatDays: calendarEvents.repeatDays, repeatAnchorDay: calendarEvents.repeatAnchorDay, repeatUntil: calendarEvents.repeatUntil, excludedOccurrences: calendarEvents.excludedOccurrences,
			recurrenceId: calendarEvents.recurrenceId, transparent: calendarEvents.transparent, responseStatus: calendarEvents.responseStatus,
		}).from(calendarEvents).where(and(inArray(calendarEvents.userId, ids.slice(index, index + USER_CHUNK)), lt(calendarEvents.startsAt, end), or(gt(calendarEvents.endsAt, start), and(ne(calendarEvents.repeat, "none"), or(isNull(calendarEvents.repeatUntil), sql`${calendarEvents.repeatUntil} + (${calendarEvents.endsAt} - ${calendarEvents.startsAt}) > ${Math.floor(from / 1000)}`)))));
		for (const row of rows) {
			if (!isBusyEvent(row)) continue;
			// The event being edited: all of it, or (with an occurrence named) that occurrence and the moved row that replaced it.
			const edited = excluded.has(row.id);
			const movedRow = !!targets.excludeEventId && row.davObjectId === targets.excludeEventId && row.id !== targets.excludeEventId;
			if (targets.excludeOccurrence === undefined ? edited || movedRow : movedRow && row.recurrenceId?.getTime() === targets.excludeOccurrence) continue;
			const duration = row.endsAt.getTime() - row.startsAt.getTime();
			if (duration <= 0) continue;
			const list = collected.get(row.userId)!;
			if ((spent.get(row.userId) ?? 0) > share) { list.push([from, to]); continue; }
			const { starts, exhausted } = expandEvent(row, new Date(from - duration), end, MAX_OCCURRENCES);
			spent.set(row.userId, (spent.get(row.userId) ?? 0) + 1 + starts.length);
			if (exhausted) { list.push([from, to]); continue; }
			for (const at of starts) {
				if (edited && at.getTime() === targets.excludeOccurrence) continue;
				const occurrenceEnd = at.getTime() + duration;
				if (occurrenceEnd > from && at.getTime() < to) list.push([Math.max(at.getTime(), from), Math.min(occurrenceEnd, to)]);
			}
		}
	}
	return new Map([...collected].map(([id, list]) => [id, mergeBusy(list)]));
}

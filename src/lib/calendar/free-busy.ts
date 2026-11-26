import { and, gt, inArray, lt, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { expandEvent } from "./rrule";
import { isBusyEvent } from "./visibility";

/** People per request and the longest window (spec F9 section 5, D-9). */
export const MAX_FREE_BUSY_IDS = 50;
export const MAX_FREE_BUSY_DAYS = 62;
/** People per statement: far under D1's 100 bound parameters with the three range conditions. */
const USER_CHUNK = 40;
/** Occurrences read per series in one window; a daily series needs 63. */
const MAX_OCCURRENCES = 2000;
const DAY = 86_400_000;

export type BusyInterval = [startMs: number, endMs: number];
/** Rooms and equipment are CS-7; until they exist `resourceIds` is accepted and ignored. */
export type FreeBusyTargets = { userIds: string[]; resourceIds?: string[] };

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
	const ids = [...new Set(targets.userIds)];
	if (ids.length > MAX_FREE_BUSY_IDS) throw new RangeError(`Free/busy covers at most ${MAX_FREE_BUSY_IDS} people at a time`);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError("Choose a start before the end");
	if (to - from > MAX_FREE_BUSY_DAYS * DAY) throw new RangeError(`Free/busy covers at most ${MAX_FREE_BUSY_DAYS} days at a time`);
	const collected = new Map<string, BusyInterval[]>(ids.map((id) => [id, []]));
	const db = getDb(env);
	for (let index = 0; index < ids.length; index += USER_CHUNK) {
		const rows = await db.select({
			userId: calendarEvents.userId, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, timeZone: calendarEvents.timeZone, repeat: calendarEvents.repeat, rrule: calendarEvents.rrule,
			repeatDays: calendarEvents.repeatDays, repeatAnchorDay: calendarEvents.repeatAnchorDay, repeatUntil: calendarEvents.repeatUntil, excludedOccurrences: calendarEvents.excludedOccurrences,
			transparent: calendarEvents.transparent, responseStatus: calendarEvents.responseStatus,
		}).from(calendarEvents).where(and(inArray(calendarEvents.userId, ids.slice(index, index + USER_CHUNK)), lt(calendarEvents.startsAt, end), or(gt(calendarEvents.endsAt, start), ne(calendarEvents.repeat, "none"))));
		for (const row of rows) {
			if (!isBusyEvent(row)) continue;
			const duration = row.endsAt.getTime() - row.startsAt.getTime();
			if (duration <= 0) continue;
			const list = collected.get(row.userId)!;
			const { starts, exhausted } = expandEvent(row, new Date(from - duration), end, MAX_OCCURRENCES);
			if (exhausted) { list.push([from, to]); continue; }
			for (const at of starts) {
				const occurrenceEnd = at.getTime() + duration;
				if (occurrenceEnd > from && at.getTime() < to) list.push([Math.max(at.getTime(), from), Math.min(occurrenceEnd, to)]);
			}
		}
	}
	return new Map([...collected].map(([id, list]) => [id, mergeBusy(list)]));
}

import { and, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, users } from "@/db/schema";
import { isValidTimeZone } from "@/lib/time/utils";
import { addZonedDays } from "./invite";
import { expandEvent } from "./rrule";

const DAY = 86_400_000;
/** People per statement: far under D1's 100 bound parameters with the three range conditions. */
export const USER_CHUNK = 40;

/** A stored zone is data from outside (CalDAV, invitations): one that is empty or not a zone counts as missing, so it cannot make an expansion throw. */
export const validZone = (zone: string | null | undefined): zone is string => !!zone && isValidTimeZone(zone);

/** A row that repeats, or an all-day one, with no usable zone of its own: the calendar view expands it in the viewer's zone (`calendarTimeZone`), which for the owner is `users.time_zone`. */
export const needsOwnerZone = (row: { timeZone?: string | null; allDay: boolean; repeat: string }) => !validZone(row.timeZone) && (row.allDay || row.repeat !== "none");

export type BusyInterval = [startMs: number, endMs: number];
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

type ExpandableRow = Parameters<typeof expandEvent>[0] & { allDay: boolean; userId: string };

/**
 * One row's occurrences as intervals clamped to [from, to] (ms), expanded the way the calendar view does (an all-day day ends at
 * the next midnight of its zone, a zoneless repeating or all-day row uses `ownerZone`). `limit` bounds the walk; `used` is the work
 * it cost (one per series plus one per occurrence found) and `truncated` says the limit ended it, so occurrences may be missing.
 * `cutoff` leaves out occurrences starting at or after it.
 */
export function expandRowBusy(row: ExpandableRow, ownerZone: string | undefined, from: number, to: number, limit: number, cutoff?: number): { busy: BusyInterval[]; used: number; truncated: boolean } {
	const duration = row.endsAt.getTime() - row.startsAt.getTime();
	// A day of an all-day series ends at the next midnight of its zone, so on a 23- or 25-hour day it is not 24 hours long.
	const zone = row.allDay || needsOwnerZone(row) ? (validZone(row.timeZone) ? row.timeZone : ownerZone ?? "UTC") : null;
	const days = Math.max(1, Math.round(duration / DAY));
	const lengthAt = (start: number) => zone && row.allDay ? addZonedDays(new Date(start), days, zone).getTime() - start : duration;
	// Its last day can be a day longer than the row (a 25-hour day against 24), so look back one day further than its length.
	const lookback = zone && row.allDay ? (days + 1) * DAY : duration;
	const { starts, exhausted } = expandEvent(zone ? { ...row, timeZone: zone } : row, new Date(from - lookback), new Date(to), limit);
	const busy: BusyInterval[] = [];
	for (const at of starts) {
		if (cutoff !== undefined && at.getTime() >= cutoff) continue;
		const occurrenceEnd = at.getTime() + lengthAt(at.getTime());
		if (occurrenceEnd > from && at.getTime() < to) busy.push([Math.max(at.getTime(), from), Math.min(occurrenceEnd, to)]);
	}
	return { busy, used: 1 + starts.length, truncated: exhausted || starts.length >= limit };
}

/** Rows that can be in [start, end): they start before it ends and end after it starts, or repeat on into it. */
export const overlapsWindow = (start: Date, end: Date) => and(lt(calendarEvents.startsAt, end), or(gt(calendarEvents.endsAt, start), and(ne(calendarEvents.repeat, "none"), or(isNull(calendarEvents.repeatUntil), sql`${calendarEvents.repeatUntil} + (${calendarEvents.endsAt} - ${calendarEvents.startsAt} + ${DAY / 1000}) > ${Math.floor(start.getTime() / 1000)}`))));

/** The time zone of each account in `ids` that has a usable one (chunked: D1 binds at most 100 parameters). */
export async function loadOwnerZones(db: ReturnType<typeof getDb>, ids: string[]): Promise<Map<string, string>> {
	const zones = new Map<string, string>();
	for (let index = 0; index < ids.length; index += USER_CHUNK) for (const owner of await db.select({ id: users.id, timeZone: users.timeZone }).from(users).where(inArray(users.id, ids.slice(index, index + USER_CHUNK)))) if (validZone(owner.timeZone)) zones.set(owner.id, owner.timeZone);
	return zones;
}


import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, davCalendarObjects } from "@/db/schema";
import { OFF_CALENDAR_RESPONSES } from "@/lib/calendar/response-status";
import { expandEvent, rruleEndedBefore } from "@/lib/calendar/rrule";
import { etagFromSeq, newestSeqOf } from "./changes";
import type { ListedRow } from "./common";
import { nativeResourceName, nativeUid, type CalendarResource, type EventRow } from "./calendar-render";

type Env = Pick<CloudflareEnv, "DB">;

/**
 * Names or ids per query. A statement binds the chunk twice (ids and names) plus the user and the three hidden
 * response states, which must stay under D1's 100 bound parameters.
 */
export const CALENDAR_CHUNK = 40;
/** Rows read for one calendar-query before it answers 507, so one request cannot read a whole large calendar. */
export const MAX_QUERY_CANDIDATES = 2000;
/** Ids per override query: the chunk plus the user stay under D1's 100 bound parameters. */
const OVERRIDE_CHUNK = 90;
/** Resources a PROPFIND depth 1 or an initial sync may list; more is 507. */
export const MAX_LISTED = 20_000;
/** Rows per listing statement. Names and ETags are streamed in pages of this size, so 20,000 resources cost 20 statements and little memory. */
export const LIST_PAGE = 1000;

const visible = or(isNull(calendarEvents.responseStatus), notInArray(calendarEvents.responseStatus, [...OFF_CALENDAR_RESPONSES]));
const isMaster = or(isNull(calendarEvents.davObjectId), eq(calendarEvents.davObjectId, calendarEvents.id));

const joined = (env: Env) =>
	getDb(env)
		.select({ event: calendarEvents, name: davCalendarObjects.name, uid: davCalendarObjects.uid })
		.from(calendarEvents)
		.leftJoin(davCalendarObjects, eq(davCalendarObjects.id, calendarEvents.id));

type Joined = { event: EventRow; name: string | null; uid: string | null };

const toResource = ({ event, name, uid }: Joined): CalendarResource => ({ id: event.id, name: name ?? nativeResourceName(event.id), uid: uid ?? nativeUid(event.id), master: event, overrides: [] });

/** Only masters made by a DAV client can have override rows. */
export const isDavMaster = (resource: CalendarResource) => resource.master.davObjectId === resource.id;

/** Attach override rows. Only masters made by a DAV client can have any (`dav_object_id = id`), so native events cost no query. */
export async function withOverrides(env: Env, userId: string, resources: CalendarResource[]): Promise<CalendarResource[]> {
	const ids = resources.filter(isDavMaster).map((resource) => resource.id);
	if (!ids.length) return resources;
	const byId = new Map(resources.map((resource) => [resource.id, resource]));
	for (let i = 0; i < ids.length; i += OVERRIDE_CHUNK) {
		const rows = await getDb(env)
			.select()
			.from(calendarEvents)
			.where(and(eq(calendarEvents.userId, userId), isNotNull(calendarEvents.davObjectId), ne(calendarEvents.davObjectId, calendarEvents.id), inArray(calendarEvents.davObjectId, ids.slice(i, i + OVERRIDE_CHUNK))))
			.orderBy(asc(calendarEvents.startsAt));
		for (const row of rows) byId.get(row.davObjectId as string)?.overrides.push(row);
	}
	return resources;
}

/**
 * The visible resources behind a set of href names, in one query per chunk. A name only matches the resource that
 * is served under exactly that name: `<id>.ics` for a native event, the stored name for a DAV-created one.
 */
export async function loadCalendarByNames(env: Env, userId: string, names: string[]): Promise<CalendarResource[]> {
	if (!names.length) return [];
	const wanted = new Set(names);
	const rows = await joined(env)
		.where(and(eq(calendarEvents.userId, userId), isMaster, visible, or(inArray(calendarEvents.id, names.map((name) => name.replace(/\.ics$/, ""))), inArray(davCalendarObjects.name, names))))
		.orderBy(asc(calendarEvents.id));
	return withOverrides(env, userId, rows.map(toResource).filter((resource) => wanted.has(resource.name)));
}

/** Visible resources in id order after `after`, one more than `limit` so the caller can tell it was cut. Without overrides: `withOverrides` adds them to the rows that need them. */
export async function listCalendar(env: Env, userId: string, limit: number, where?: ReturnType<typeof and>, after?: string): Promise<CalendarResource[]> {
	const rows = await joined(env)
		.where(and(eq(calendarEvents.userId, userId), isMaster, visible, where, after === undefined ? undefined : gt(calendarEvents.id, after)))
		.orderBy(asc(calendarEvents.id))
		.limit(limit + 1);
	return rows.map(toResource);
}

/**
 * Whether a repeating series has ended before the range, so it cannot have an occurrence in it and is not a candidate:
 * by its UNTIL column or, for a custom rule, by walking the rule (never when the walk ran out of budget). A DAV series is
 * never ended here: its override rows can still stand in the range.
 */
export function endedBefore(resource: CalendarResource, start: Date): boolean {
	const { master } = resource;
	if (master.repeat === "none" || isDavMaster(resource)) return false;
	const duration = master.endsAt.getTime() - master.startsAt.getTime();
	if (master.repeat === "custom") return !!master.rrule && rruleEndedBefore(master.rrule, master.startsAt, master.timeZone, duration === 0 ? start : new Date(start.getTime() - duration + 1));
	// `repeatUntil` is exclusive: the last occurrence starts before it and ends before it plus the duration.
	return !!master.repeatUntil && master.repeatUntil.getTime() + duration <= start.getTime();
}

/** Rows that could have an occurrence inside the range: selected like `availableBookingSlots`, so repeating events always qualify. */
export const overlapsRange = (start: Date, end: Date) => and(lt(calendarEvents.startsAt, end), or(gt(calendarEvents.endsAt, start), ne(calendarEvents.repeat, "none")));

/** The resource with a given iCalendar UID: a stored UID, or `<id>@mailflare` for a native event. */
export const matchesUid = (uid: string) =>
	or(eq(davCalendarObjects.uid, uid), eq(calendarEvents.id, uid.endsWith("@mailflare") ? uid.slice(0, -"@mailflare".length) : "\u0000"));

/** Whether a resource has an occurrence overlapping [start, end). `exhausted` when the expansion budget ended before an answer. */
export function occursInRange(resource: CalendarResource, start: Date, end: Date): { match: boolean; exhausted: boolean } {
	const overlaps = (at: number, duration: number) => (duration === 0 ? at >= start.getTime() && at < end.getTime() : at < end.getTime() && at + duration > start.getTime());
	const duration = resource.master.endsAt.getTime() - resource.master.startsAt.getTime();
	// Two results are enough: only an occurrence ending exactly at `start` can sit in the window without overlapping it.
	const { starts, exhausted } = expandEvent(resource.master, new Date(start.getTime() - duration), end, 2);
	if (starts.some((at) => overlaps(at.getTime(), duration))) return { match: true, exhausted: false };
	for (const row of resource.overrides) if (overlaps(row.startsAt.getTime(), row.endsAt.getTime() - row.startsAt.getTime())) return { match: true, exhausted: false };
	return { match: false, exhausted };
}

/** Name and update time of the visible resources among some event ids (the master rows), for sync-collection. */
export async function liveCalendarNames(env: Env, userId: string, ids: string[]): Promise<Map<string, { name: string; updatedAt: Date }>> {
	const live = new Map<string, { name: string; updatedAt: Date }>();
	for (let i = 0; i < ids.length; i += 90) {
		const rows = await getDb(env)
			.select({ id: calendarEvents.id, name: davCalendarObjects.name, updatedAt: calendarEvents.updatedAt })
			.from(calendarEvents)
			.leftJoin(davCalendarObjects, eq(davCalendarObjects.id, calendarEvents.id))
			.where(and(eq(calendarEvents.userId, userId), isMaster, visible, inArray(calendarEvents.id, ids.slice(i, i + 90))));
		for (const row of rows) live.set(row.id, { name: row.name ?? nativeResourceName(row.id), updatedAt: row.updatedAt });
	}
	return live;
}

const listing = (env: Env, userId: string, cid: string, after: string) =>
	getDb(env)
		.select({ id: calendarEvents.id, name: davCalendarObjects.name, updatedAt: calendarEvents.updatedAt, seq: newestSeqOf(cid, calendarEvents.id) })
		.from(calendarEvents)
		.leftJoin(davCalendarObjects, eq(davCalendarObjects.id, calendarEvents.id))
		.where(and(eq(calendarEvents.userId, userId), isMaster, visible, gt(calendarEvents.id, after)))
		.orderBy(asc(calendarEvents.id))
		.limit(LIST_PAGE);

/** How many visible resources the calendar has. */
export async function countCalendar(env: Env, userId: string): Promise<number> {
	const [row] = await getDb(env).select({ count: sql<number>`count(*)` }).from(calendarEvents).where(and(eq(calendarEvents.userId, userId), isMaster, visible));
	return Number(row?.count ?? 0);
}

/** Every visible resource's name and ETag, in pages of LIST_PAGE by id (keyset): one statement a page, for PROPFIND depth 1 and the first sync. Stops at MAX_LISTED. */
export async function* pageCalendar(env: Env, userId: string, cid: string): AsyncGenerator<ListedRow[]> {
	let after = "";
	for (let listed = 0; listed < MAX_LISTED; ) {
		const rows = await listing(env, userId, cid, after);
		if (!rows.length) return;
		yield rows.map((row) => ({ name: row.name ?? nativeResourceName(row.id), etag: etagFromSeq(row.seq, row.updatedAt), updatedAt: row.updatedAt }));
		if (rows.length < LIST_PAGE) return;
		listed += rows.length;
		after = rows[rows.length - 1].id;
	}
}

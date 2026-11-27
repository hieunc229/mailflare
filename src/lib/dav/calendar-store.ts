import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, davCalendarObjects } from "@/db/schema";
import { OFF_CALENDAR_RESPONSES } from "@/lib/calendar/response-status";
import { expandEvent, rruleEndedBefore } from "@/lib/calendar/rrule";
import { etagFromSeq, newestSeqOf } from "./changes";
import type { ListedRow } from "./common";
import { rowsHash } from "./calendar-merge";
import { nativeResourceName, nativeUid, type CalendarResource, type EventRow } from "./calendar-render";
import { inCalendar, scopeOf, type CalendarScope } from "./calendar-scope";

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
		.select({ event: calendarEvents, name: davCalendarObjects.name, uid: davCalendarObjects.uid, size: davCalendarObjects.size })
		.from(calendarEvents)
		.leftJoin(davCalendarObjects, eq(davCalendarObjects.id, calendarEvents.id));

type Joined = { event: EventRow; name: string | null; uid: string | null; size: number | null };

/** A resource of a collection; `role` is the viewer's, which decides what the rendered body shows (D-6). */
const toResource = (scope: CalendarScope) => ({ event, name, uid, size }: Joined): CalendarResource => ({ id: event.id, name: name ?? nativeResourceName(event.id), uid: uid ?? nativeUid(event.id), master: event, overrides: [], size: size ?? undefined, role: scope.role });

/** A response is cut into groups whose stored bodies add up to at most this many bytes (always at least one resource), so bodies never sit in memory together. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/** Groups of resources that have their bodies loaded and rendered together: at most 90 resources and CHUNK_BYTES, from the sizes already known. */
export function planCalendarChunks(resources: CalendarResource[]): CalendarResource[][] {
	const chunks: CalendarResource[][] = [];
	let current: CalendarResource[] = [];
	let bytes = 0;
	for (const resource of resources) {
		const size = resource.size ?? 0;
		if (current.length && (current.length >= OVERRIDE_CHUNK || bytes + size > CHUNK_BYTES)) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(resource);
		bytes += size;
	}
	if (current.length) chunks.push(current);
	return chunks;
}

/** Bytes of the user's stored calendar resources (the covering index on user and size answers it without reading bodies). */
export async function calendarBytes(env: Env, userId: string): Promise<number> {
	const [row] = await getDb(env).select({ total: sql<number | null>`sum(${davCalendarObjects.size})` }).from(davCalendarObjects).where(eq(davCalendarObjects.userId, userId));
	return Number(row?.total ?? 0);
}

/** Only masters made by a DAV client can have override rows. */
export const isDavMaster = (resource: CalendarResource) => resource.master.davObjectId === resource.id;

/** Attach override rows. Only masters made by a DAV client can have any (`dav_object_id = id`), so native events cost no query. */
export async function withOverrides(env: Env, calendar: CalendarScope | string, resources: CalendarResource[]): Promise<CalendarResource[]> {
	const scope = scopeOf(calendar);
	const ids = resources.filter(isDavMaster).map((resource) => resource.id);
	if (!ids.length) return resources;
	const byId = new Map(resources.map((resource) => [resource.id, resource]));
	for (let i = 0; i < ids.length; i += OVERRIDE_CHUNK) {
		const rows = await getDb(env)
			.select()
			.from(calendarEvents)
			.where(and(inCalendar(scope), isNotNull(calendarEvents.davObjectId), ne(calendarEvents.davObjectId, calendarEvents.id), inArray(calendarEvents.davObjectId, ids.slice(i, i + OVERRIDE_CHUNK))))
			.orderBy(asc(calendarEvents.startsAt));
		for (const row of rows) byId.get(row.davObjectId as string)?.overrides.push(row);
	}
	return resources;
}

/**
 * Attach the body a client PUT to the DAV-written resources (their overrides must be loaded already): `stored.fresh` says
 * no row changed since it was written. Kept apart from withOverrides because only the resources that are answered need it.
 */
export async function withStored(env: Env, userId: string, resources: CalendarResource[]): Promise<CalendarResource[]> {
	// Only the owner is served what a client PUT: everyone else gets a body generated from the rows, redacted for their role (D-12).
	const byId = new Map(resources.filter((resource) => isDavMaster(resource) && (!resource.role || resource.role === "owner")).map((resource) => [resource.id, resource]));
	const ids = [...byId.keys()];
	for (let i = 0; i < ids.length; i += OVERRIDE_CHUNK) {
		const rows = await getDb(env).select({ id: davCalendarObjects.id, body: davCalendarObjects.body, rowsHash: davCalendarObjects.rowsHash }).from(davCalendarObjects).where(and(eq(davCalendarObjects.userId, userId), inArray(davCalendarObjects.id, ids.slice(i, i + OVERRIDE_CHUNK))));
		for (const row of rows) {
			const resource = byId.get(row.id)!;
			if (row.body !== null) resource.stored = { body: row.body, fresh: row.rowsHash !== null && row.rowsHash === (await rowsHash(resource.master, resource.overrides)) };
		}
	}
	return resources;
}

/** Drops the stored bodies of a group once its response has been sent, so at most one group of bodies is in memory. */
export function releaseStored(resources: CalendarResource[]): void {
	for (const resource of resources) resource.stored = undefined;
}

/**
 * The visible resources behind a set of href names, in one query per chunk (`bodies` false: without the stored bodies, which the caller loads with `withStored` in planned chunks). A name only matches the resource that
 * is served under exactly that name: `<id>.ics` for a native event, the stored name for a DAV-created one.
 */
export async function loadCalendarByNames(env: Env, calendar: CalendarScope | string, names: string[], bodies = true): Promise<CalendarResource[]> {
	if (!names.length) return [];
	const scope = scopeOf(calendar);
	const wanted = new Set(names);
	const rows = await joined(env)
		.where(and(inCalendar(scope), isMaster, visible, or(inArray(calendarEvents.id, names.map((name) => name.replace(/\.ics$/, ""))), inArray(davCalendarObjects.name, names))))
		.orderBy(asc(calendarEvents.id));
	const resources = await withOverrides(env, scope, rows.map(toResource(scope)).filter((resource) => wanted.has(resource.name)));
	return bodies ? withStored(env, scope.ownerId, resources) : resources;
}

/**
 * The resource served under a name whether or not it is visible: a PUT onto the name of a hidden (cancelled, declined)
 * resource replaces it, and DELETE removes it. Hidden resources are the owner's alone: for anyone else they are not there. Without the stored body and overrides: a write replaces both.
 */
export async function findCalendarByName(env: Env, calendar: CalendarScope | string, name: string, withHidden = false): Promise<CalendarResource | undefined> {
	const scope = scopeOf(calendar);
	const rows = await joined(env).where(and(inCalendar(scope), isMaster, withHidden || !scope.role || scope.role === "owner" ? undefined : visible, or(eq(davCalendarObjects.name, name), eq(calendarEvents.id, name.replace(/\.ics$/, "")))));
	return rows.map(toResource(scope)).find((resource) => resource.name === name);
}

/** Another resource of this calendar that already has this UID (a stored UID, or `<id>@mailflare` of a native event), hidden ones included. A UID is unique per collection. */
export async function findUidConflict(env: Env, calendar: CalendarScope | string, uid: string, exceptId: string | null): Promise<CalendarResource | undefined> {
	const scope = scopeOf(calendar);
	const rows = await joined(env).where(and(inCalendar(scope), isMaster, matchesUid(uid), exceptId === null ? undefined : ne(calendarEvents.id, exceptId)));
	return rows.map(toResource(scope)).find((resource) => resource.uid === uid);
}

/** Visible resources in id order after `after`, one more than `limit` so the caller can tell it was cut. Without overrides: `withOverrides` adds them to the rows that need them. */
export async function listCalendar(env: Env, calendar: CalendarScope | string, limit: number, where?: ReturnType<typeof and>, after?: string): Promise<CalendarResource[]> {
	const scope = scopeOf(calendar);
	const rows = await joined(env)
		.where(and(inCalendar(scope), isMaster, visible, where, after === undefined ? undefined : gt(calendarEvents.id, after)))
		.orderBy(asc(calendarEvents.id))
		.limit(limit + 1);
	return rows.map(toResource(scope));
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
export async function liveCalendarNames(env: Env, calendar: CalendarScope | string, ids: string[]): Promise<Map<string, { name: string; updatedAt: Date }>> {
	const scope = scopeOf(calendar);
	const live = new Map<string, { name: string; updatedAt: Date }>();
	for (let i = 0; i < ids.length; i += 90) {
		const rows = await getDb(env)
			.select({ id: calendarEvents.id, name: davCalendarObjects.name, updatedAt: calendarEvents.updatedAt })
			.from(calendarEvents)
			.leftJoin(davCalendarObjects, eq(davCalendarObjects.id, calendarEvents.id))
			.where(and(inCalendar(scope), isMaster, visible, inArray(calendarEvents.id, ids.slice(i, i + 90))));
		for (const row of rows) live.set(row.id, { name: row.name ?? nativeResourceName(row.id), updatedAt: row.updatedAt });
	}
	return live;
}

/** Names of masters that exist but are not served (needs-action, declined, cancelled), so sync can still report them gone by name. */
export async function hiddenCalendarNames(env: Env, calendar: CalendarScope | string, ids: string[]): Promise<Map<string, string>> {
	const scope = scopeOf(calendar);
	const names = new Map<string, string>();
	for (let i = 0; i < ids.length; i += 90) {
		const rows = await getDb(env)
			.select({ id: calendarEvents.id, name: davCalendarObjects.name })
			.from(calendarEvents)
			.leftJoin(davCalendarObjects, eq(davCalendarObjects.id, calendarEvents.id))
			.where(and(inCalendar(scope), isMaster, inArray(calendarEvents.id, ids.slice(i, i + 90))));
		for (const row of rows) names.set(row.id, row.name ?? nativeResourceName(row.id));
	}
	return names;
}

const listing = (env: Env, scope: CalendarScope, after: string) =>
	getDb(env)
		.select({ id: calendarEvents.id, name: davCalendarObjects.name, updatedAt: calendarEvents.updatedAt, seq: newestSeqOf([scope.id], calendarEvents.id) })
		.from(calendarEvents)
		.leftJoin(davCalendarObjects, eq(davCalendarObjects.id, calendarEvents.id))
		.where(and(inCalendar(scope), isMaster, visible, gt(calendarEvents.id, after)))
		.orderBy(asc(calendarEvents.id))
		.limit(LIST_PAGE);

/** How many visible resources the calendar has. */
export async function countCalendar(env: Env, calendar: CalendarScope | string): Promise<number> {
	const [row] = await getDb(env).select({ count: sql<number>`count(*)` }).from(calendarEvents).where(and(inCalendar(scopeOf(calendar)), isMaster, visible));
	return Number(row?.count ?? 0);
}

/** Every visible resource's name and ETag, in pages of LIST_PAGE by id (keyset): one statement a page, for PROPFIND depth 1 and the first sync. Stops at MAX_LISTED. */
export async function* pageCalendar(env: Env, calendar: CalendarScope | string): AsyncGenerator<ListedRow[]> {
	const scope = scopeOf(calendar);
	let after = "";
	for (let listed = 0; listed < MAX_LISTED; ) {
		const rows = await listing(env, scope, after);
		if (!rows.length) return;
		yield rows.map((row) => ({ name: row.name ?? nativeResourceName(row.id), etag: etagFromSeq(row.seq, row.updatedAt), updatedAt: row.updatedAt }));
		if (rows.length < LIST_PAGE) return;
		listed += rows.length;
		after = rows[rows.length - 1].id;
	}
}

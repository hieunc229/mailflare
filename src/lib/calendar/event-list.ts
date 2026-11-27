import { and, eq, gte, inArray, lt, ne, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { calendarCollectionId } from "@/lib/dav/changes";
import { isOffCalendarResponse } from "./response-status";
import { calendarFilter, eventCalendarId, ownCalendarIds } from "./calendars";
import { calendarScopes, grantedCalendars, roleAtLeast } from "./shares";
import type { CalendarRole } from "./shares-types";
import { isBusyEvent, redactEvent } from "./visibility";

type Db = ReturnType<typeof getDb>;
const MASTER_CHUNK = 90;

/**
 * Events in a range that `user` may read: their own, and those of calendars shared with them, each redacted for the role
 * (D-6). Without `requested` that is every own calendar and every grant of `read` or better; naming calendars narrows it, and
 * is the only way to read a `freebusy` grant (blocks, no details). A calendar the user has no role on is silently empty.
 * Shared calendars are read in statements of at most 40 calendars each (D1's 100 bound parameters).
 */
export async function listVisibleEvents(db: Db, user: { id: string }, range: { start: Date; end: Date }, requested: string[]) {
	const inRange = and(lt(calendarEvents.startsAt, range.end), or(gte(calendarEvents.endsAt, range.start), ne(calendarEvents.repeat, "none")))!;
	const known = new Set(await ownCalendarIds(db, user.id));
	const ownRequested = requested.filter((id) => known.has(id));
	const own = !requested.length || ownRequested.length
		? (await db.select().from(calendarEvents).where(and(requested.length ? calendarFilter(user.id, ownRequested) : eq(calendarEvents.userId, user.id), inRange))).map((row) => ({ ...row, calendarId: eventCalendarId(row, known), role: "owner" as CalendarRole }))
		: [];
	const grants = (await grantedCalendars(db, user.id)).filter((grant) => (requested.length ? requested.includes(grant.id) : grant.role !== "freebusy"));
	const roles = new Map(grants.map((grant) => [grant.id, grant.role as CalendarRole]));
	const shared: typeof own = [];
	if (grants.length) {
		for (const scope of calendarScopes(grants)) {
			for (const row of await db.select().from(calendarEvents).where(and(scope, inRange))) {
				const calendarId = row.calendarId ?? calendarCollectionId(row.userId);
				const role = roles.get(calendarId);
				// A row whose user is not its calendar's owner (D-2) is not served through that calendar's grant.
				if (!role || !grants.some((grant) => grant.id === calendarId && grant.ownerId === row.userId)) continue;
				// Invitations the owner has not answered, and declined or cancelled ones, are not on the calendar for anyone else.
				if (isOffCalendarResponse(row.responseStatus) || (role === "freebusy" && !isBusyEvent(row))) continue;
				shared.push({ ...(row as typeof row), calendarId, role });
			}
		}
		// A moved occurrence is a row of its own, but it belongs to its series: private when the series is. Only readers need to know,
		// and only for override rows, fetched by id in chunks well under D1's 100 bound parameters.
		const overrideOf = (row: (typeof shared)[number]) => (row.davObjectId && row.davObjectId !== row.id ? row.davObjectId : null);
		const masters = [...new Set(shared.filter((row) => row.role !== "owner" && !roleAtLeast(row.role, "edit") && !row.isPrivate).map(overrideOf).filter((id): id is string => !!id))];
		const privateMasters = new Set<string>();
		for (let index = 0; index < masters.length; index += MASTER_CHUNK) {
			for (const master of await db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(inArray(calendarEvents.id, masters.slice(index, index + MASTER_CHUNK)), eq(calendarEvents.isPrivate, true)))) privateMasters.add(master.id);
		}
		for (let index = 0; index < shared.length; index += 1) {
			const row = shared[index];
			const master = overrideOf(row);
			shared[index] = { ...redactEvent(master && privateMasters.has(master) ? { ...row, isPrivate: true } : row, row.role), isPrivate: row.isPrivate, calendarId: row.calendarId, role: row.role };
		}
	}
	return [...own, ...shared].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

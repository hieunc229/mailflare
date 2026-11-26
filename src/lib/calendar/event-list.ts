import { and, eq, gte, lt, ne, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { calendarCollectionId } from "@/lib/dav/changes";
import { calendarFilter, eventCalendarId, ownCalendarIds } from "./calendars";
import { calendarScopes, grantedCalendars } from "./shares";
import type { CalendarRole } from "./shares-types";
import { isBusyEvent, redactEvent } from "./visibility";

type Db = ReturnType<typeof getDb>;

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
				if (role === "freebusy" && !isBusyEvent(row)) continue;
				shared.push({ ...redactEvent(row, role), calendarId, role });
			}
		}
	}
	return [...own, ...shared].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

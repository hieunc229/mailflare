import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarShares, davCollections } from "@/db/schema";
import { getCalendarAccess, listSharedGrants } from "@/lib/calendar/shares";
import type { CalendarRole } from "@/lib/calendar/shares-types";
import type { CalendarScope } from "./calendar-scope";
import { calendarCollectionId } from "./changes";

/**
 * A calendar collection of one user's CalDAV home (spec F9 D-12): the segment it is served under, and the calendar behind it
 * with the role the requesting user has there. `grantId` is set for `shared-<grantId>`.
 */
export type CalendarCollection = CalendarScope & { role: CalendarRole; segment: string; grantId: string | null };

/** The collection's own properties, as a home listing preloads them (one read for all instead of one per collection). */
export type CalendarListing = CalendarCollection & { displayName: string | null; color: string | null; description: string | null; sortOrder: number | null; ownerName: string | null };

const ID_CHARS = "[A-Za-z0-9._~@+=-]{1,190}";
/** `default`, `c-<suffix of an own calendar id>`, `shared-<grant id>`; anything else is not a calendar of the home. */
export const CALENDAR_SEGMENT = new RegExp(`^(default|c-${ID_CHARS}|shared-${ID_CHARS})$`);

const OWN_PREFIX = "c-";
const SHARED_PREFIX = "shared-";
const ID_PREFIX = "cal:";

/** The segment an own calendar is served under: `default`, or `c-` and the id without its `cal:`. */
export const ownSegment = (userId: string, calendarId: string) => (calendarId === calendarCollectionId(userId) ? "default" : `${OWN_PREFIX}${calendarId.slice(ID_PREFIX.length)}`);
export const sharedSegment = (grantId: string) => `${SHARED_PREFIX}${grantId}`;

const collectionOf = (id: string, ownerId: string, role: CalendarRole, segment: string, grantId: string | null): CalendarCollection => ({ id, ownerId, role, segment, grantId, isDefault: id === calendarCollectionId(ownerId) });

/**
 * The calendar a request path names, with the user's role in it, or null (404: it is not there, or not theirs; the two look alike).
 * The role comes from `getCalendarAccess`, the one check every calendar surface uses, on every request: a revoked grant, a disabled
 * owner or an owner with Calendar off closes the collection on the next request. A re-keyed grant (D-5) no longer has its old id,
 * so the old `shared-<oldId>` is gone and the phone resyncs. A `freebusy` grant is not a collection; an own calendar is only served
 * under its own `default` or `c-` name, a granted one only under `shared-`.
 */
export async function resolveCalendarCollection(env: Pick<CloudflareEnv, "DB">, user: { id: string }, segment: string): Promise<CalendarCollection | null> {
	if (!CALENDAR_SEGMENT.test(segment)) return null;
	const db = getDb(env);
	if (segment === "default") return collectionOf(calendarCollectionId(user.id), user.id, "owner", segment, null);
	if (segment.startsWith(OWN_PREFIX)) {
		const id = `${ID_PREFIX}${segment.slice(OWN_PREFIX.length)}`;
		if (id === calendarCollectionId(user.id)) return null;
		const access = await getCalendarAccess(db, user, id);
		return access?.role === "owner" ? collectionOf(id, user.id, "owner", segment, null) : null;
	}
	const grantId = segment.slice(SHARED_PREFIX.length);
	const [grant] = await db.select({ calendarId: calendarShares.calendarId }).from(calendarShares).where(and(eq(calendarShares.id, grantId), eq(calendarShares.granteeUserId, user.id))).limit(1);
	if (!grant) return null;
	const access = await getCalendarAccess(db, user, grant.calendarId);
	if (!access || access.role === "owner" || access.role === "freebusy") return null;
	return collectionOf(grant.calendarId, access.ownerId, access.role, segment, grantId);
}

/** Every calendar collection of the home, the default first, then own ones oldest first, then shared: two statements however many there are. */
export async function listCalendarCollections(env: Pick<CloudflareEnv, "DB">, user: { id: string }): Promise<CalendarListing[]> {
	const db = getDb(env);
	const defaultId = calendarCollectionId(user.id);
	const rows = await db.select().from(davCollections).where(and(eq(davCollections.userId, user.id), eq(davCollections.kind, "calendar"))).orderBy(asc(davCollections.createdAt), asc(davCollections.id));
	const row = (id: string) => rows.find((candidate) => candidate.id === id);
	const own = [defaultId, ...rows.filter((candidate) => candidate.id !== defaultId).map((candidate) => candidate.id)].map((id): CalendarListing => ({ ...collectionOf(id, user.id, "owner", ownSegment(user.id, id), null), displayName: row(id)?.displayName ?? null, color: row(id)?.color ?? null, description: row(id)?.description ?? null, sortOrder: row(id)?.sortOrder ?? null, ownerName: null }));
	const shared = (await listSharedGrants(db, user.id)).map((grant): CalendarListing => ({ ...collectionOf(grant.calendarId, grant.ownerId, grant.role, sharedSegment(grant.grantId), grant.grantId), displayName: grant.displayName, color: grant.color, description: grant.description, sortOrder: grant.sortOrder, ownerName: grant.ownerName }));
	return [...own, ...shared];
}

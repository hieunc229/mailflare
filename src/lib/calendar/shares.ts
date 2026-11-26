import { and, asc, count, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, calendarShares, davCollections, domains, mailboxes, users } from "@/db/schema";
import { matchNothing } from "@/db/sql";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { calendarCollectionId } from "@/lib/dav/changes";
import { newId } from "@/lib/ids";
import { paletteColor } from "./calendars";
import type { CalendarSummary } from "./calendars-types";
import type { CalendarGrantRole, CalendarRole, GrantedCalendar, ShareChangeResult, ShareEntry, ShareFailure, ShareGrantResult, ShareListResult, ShareRevokeResult } from "./shares-types";
import { listOwnCalendars } from "./calendars";

type Db = ReturnType<typeof getDb>;
type Actor = { id: string };

/** Grants per calendar (spec F9 section 5). */
export const MAX_SHARES = 100;
/** Calendars per statement when filtering events by calendar: ids plus owner ids stay far under D1's 100 bound parameters. */
const SCOPE_CHUNK = 40;
/** A user rarely holds more than a handful of grants; this bounds the list reads. */
const MAX_GRANTS_READ = 500;

export const GRANT_ROLES: readonly CalendarGrantRole[] = ["freebusy", "read", "edit", "manage"];
const RANK: Record<CalendarRole, number> = { freebusy: 1, read: 2, edit: 3, manage: 4, owner: 5 };

export const isGrantRole = (value: unknown): value is CalendarGrantRole => typeof value === "string" && (GRANT_ROLES as readonly string[]).includes(value);
/** True when `role` is at least `minimum` (null, the answer for a calendar the user cannot see, is never enough). */
export const roleAtLeast = (role: CalendarRole | null | undefined, minimum: CalendarRole): boolean => !!role && RANK[role] >= RANK[minimum];

const fail = (status: ShareFailure["status"], error: string, code?: ShareFailure["code"]): ShareFailure => ({ ok: false, status, error, ...(code ? { code } : {}) });

type Access = { role: CalendarRole; ownerId: string };

/**
 * The one answer to "what may this user do in this calendar" (D-4): owner, a granted role, or null (no such calendar and no
 * grant look the same, so ids cannot be probed). A disabled or deleted owner, or one with Calendar turned off, closes the calendar to everyone else.
 */
export async function getCalendarAccess(db: Db, user: Actor, calendarId: string): Promise<Access | null> {
	// The default calendar's row is lazy, so it is the user's own by its id alone.
	if (calendarId === calendarCollectionId(user.id)) return { role: "owner", ownerId: user.id };
	const [row] = await db.select({ ownerId: davCollections.userId, disabled: users.disabled, calendarEnabled: users.calendarEnabled }).from(davCollections)
		.innerJoin(users, eq(users.id, davCollections.userId))
		.where(and(eq(davCollections.id, calendarId), eq(davCollections.kind, "calendar"))).limit(1);
	if (!row) return null;
	if (row.ownerId === user.id) return { role: "owner", ownerId: row.ownerId };
	if (row.disabled || !row.calendarEnabled) return null;
	const [grant] = await db.select({ role: calendarShares.role }).from(calendarShares).where(and(eq(calendarShares.calendarId, calendarId), eq(calendarShares.granteeUserId, user.id))).limit(1);
	return grant ? { role: grant.role, ownerId: row.ownerId } : null;
}

export async function getCalendarRole(db: Db, user: Actor, calendarId: string): Promise<CalendarRole | null> {
	return (await getCalendarAccess(db, user, calendarId))?.role ?? null;
}

/**
 * The role a user has on one event, from the calendar the row is in (D-1, D-2). A row's user id is its calendar's owner, so a
 * row whose calendar belongs to someone else, or whose calendar is gone, opens nothing to a non-owner.
 */
export async function getEventAccess(db: Db, user: Actor, event: { userId: string; calendarId: string | null }): Promise<CalendarRole | null> {
	if (event.userId === user.id) return "owner";
	const access = await getCalendarAccess(db, user, event.calendarId ?? calendarCollectionId(event.userId));
	return access && access.ownerId === event.userId ? access.role : null;
}

/** Every calendar the user holds a grant on (any role, free/busy included), owner active. Newest first is not needed: ids are keys. */
export async function grantedCalendars(db: Db, userId: string): Promise<GrantedCalendar[]> {
	const rows = await db.select({ id: calendarShares.calendarId, role: calendarShares.role, ownerId: davCollections.userId }).from(calendarShares)
		.innerJoin(davCollections, eq(davCollections.id, calendarShares.calendarId))
		.innerJoin(users, eq(users.id, davCollections.userId))
		.where(and(eq(calendarShares.granteeUserId, userId), eq(davCollections.kind, "calendar"), eq(users.disabled, false), eq(users.calendarEnabled, true)))
		.limit(MAX_GRANTS_READ);
	return rows;
}

/** The user's own calendars, then those shared with them as `read` or better (a `freebusy` grant is not a calendar to show). */
export async function listVisibleCalendars(db: Db, user: Actor): Promise<CalendarSummary[]> {
	const own = await listOwnCalendars(db, user.id);
	const rows = await db.select({ id: davCollections.id, name: davCollections.displayName, color: davCollections.color, description: davCollections.description, role: calendarShares.role, ownerId: users.id, ownerName: users.name, ownerEmail: users.email }).from(calendarShares)
		.innerJoin(davCollections, eq(davCollections.id, calendarShares.calendarId))
		.innerJoin(users, eq(users.id, davCollections.userId))
		.where(and(eq(calendarShares.granteeUserId, user.id), inArray(calendarShares.role, ["read", "edit", "manage"]), eq(davCollections.kind, "calendar"), eq(users.disabled, false), eq(users.calendarEnabled, true)))
		.orderBy(asc(davCollections.createdAt), asc(davCollections.id)).limit(MAX_GRANTS_READ);
	const shared: CalendarSummary[] = rows.map((row) => ({ id: row.id, name: row.name, color: paletteColor(row.color), description: row.description ?? "", isDefault: false, role: row.role, ownerId: row.ownerId, ownerName: row.ownerName || row.ownerEmail, eventCount: 0 }));
	return [...own, ...shared];
}

/**
 * Conditions selecting events of the given shared calendars: `calendar_id IN (...)`, plus the owner's events without a calendar
 * for a default calendar (their id is the owner's). Chunked so each statement binds at most 2 x SCOPE_CHUNK ids; the caller runs
 * one query per condition and merges. `(calendar_id, starts_at)` serves the first branch, `user_id` the second.
 */
export function calendarScopes(calendars: { id: string; ownerId: string }[]): SQL[] {
	if (!calendars.length) return [matchNothing];
	const scopes: SQL[] = [];
	for (let index = 0; index < calendars.length; index += SCOPE_CHUNK) {
		const chunk = calendars.slice(index, index + SCOPE_CHUNK);
		const owners = [...new Set(chunk.filter((calendar) => calendar.id === calendarCollectionId(calendar.ownerId)).map((calendar) => calendar.ownerId))];
		scopes.push((owners.length
			? or(inArray(calendarEvents.calendarId, chunk.map((calendar) => calendar.id)), and(isNull(calendarEvents.calendarId), inArray(calendarEvents.userId, owners)))
			: inArray(calendarEvents.calendarId, chunk.map((calendar) => calendar.id)))!);
	}
	return scopes;
}

// ---- Grants -----------------------------------------------------------------------------------------------------------

async function shareEntry(db: Db, row: { id: string; granteeUserId: string | null; role: CalendarGrantRole; createdAt: Date }): Promise<ShareEntry> {
	const [person] = row.granteeUserId ? await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.granteeUserId)).limit(1) : [];
	return { id: row.id, userId: row.granteeUserId ?? "", name: person?.name ?? "", email: person?.email ?? "", role: row.role, createdAt: row.createdAt.toISOString() };
}

/** Sharing is managed by the owner and by `manage` grantees. Someone who cannot see the calendar is told it does not exist. */
async function requireManager(db: Db, actor: Actor, calendarId: string): Promise<Access | ShareFailure> {
	const access = await getCalendarAccess(db, actor, calendarId);
	if (!access || access.role === "freebusy") return fail(404, "Calendar not found");
	return roleAtLeast(access.role, "manage") ? access : fail(403, "You cannot change who this calendar is shared with");
}

const isFailure = (value: Access | ShareFailure): value is ShareFailure => "ok" in value;

/** The active account an address belongs to: its sign-in address, else a personal mailbox it owns. Anything else is "not found", the same for every reason. */
async function findAccount(db: Db, raw: unknown): Promise<string | null> {
	const address = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	const at = address.lastIndexOf("@");
	if (at < 1 || at === address.length - 1 || address.length > 254) return null;
	let id = (await db.select({ id: users.id }).from(users).where(eq(users.email, address)).limit(1))[0]?.id;
	if (!id) {
		const [mailbox] = await db.select({ id: mailboxes.userId }).from(mailboxes).innerJoin(domains, eq(domains.id, mailboxes.domainId))
			.where(and(eq(domains.hostname, address.slice(at + 1)), eq(mailboxes.localPart, address.slice(0, at)), eq(mailboxes.type, "personal"), eq(mailboxes.disabled, false))).limit(1);
		id = mailbox?.id;
	}
	if (!id) return null;
	const [account] = await db.select({ disabled: users.disabled, calendarEnabled: users.calendarEnabled }).from(users).where(eq(users.id, id)).limit(1);
	return account && !account.disabled && account.calendarEnabled ? id : null;
}

export async function listShares(db: Db, actor: Actor, calendarId: string): Promise<ShareListResult> {
	const access = await requireManager(db, actor, calendarId);
	if (isFailure(access)) return access;
	const rows = await db.select({ id: calendarShares.id, granteeUserId: calendarShares.granteeUserId, role: calendarShares.role, createdAt: calendarShares.createdAt, name: users.name, email: users.email }).from(calendarShares)
		.innerJoin(users, eq(users.id, calendarShares.granteeUserId)).where(eq(calendarShares.calendarId, calendarId)).orderBy(asc(calendarShares.createdAt), asc(calendarShares.id)).limit(MAX_SHARES + 1);
	return { ok: true, ownerId: access.ownerId, role: access.role, shares: rows.map((row) => ({ id: row.id, userId: row.granteeUserId ?? "", name: row.name, email: row.email, role: row.role, createdAt: row.createdAt.toISOString() })) };
}

const countShares = async (db: Db, calendarId: string) => Number((await db.select({ n: count() }).from(calendarShares).where(eq(calendarShares.calendarId, calendarId)))[0].n);

export async function grantShare(db: Db, actor: Actor, calendarId: string, input: { email?: unknown; role?: unknown }): Promise<ShareGrantResult> {
	const access = await requireManager(db, actor, calendarId);
	if (isFailure(access)) return access;
	if (!isGrantRole(input.role)) return fail(400, "Choose a role");
	if (RANK[input.role] > RANK[access.role]) return fail(403, "You cannot give more access than you have");
	const targetId = await findAccount(db, input.email);
	if (!targetId) return fail(404, "No account uses that address");
	if (targetId === access.ownerId || targetId === actor.id) return fail(400, "That person already has full access");
	if (await countShares(db, calendarId) >= MAX_SHARES) return fail(409, `A calendar can be shared with up to ${MAX_SHARES} people`, "SHARE_LIMIT");
	const now = new Date();
	// The default calendar's row is created on the first share (D-1); only its owner can get here without one.
	if (calendarId === calendarCollectionId(access.ownerId)) {
		await db.insert(davCollections).values({ id: calendarId, userId: access.ownerId, kind: "calendar", displayName: null, color: null, description: null, sortOrder: null, deadProps: "{}", seededAt: null, createdAt: now, updatedAt: now }).onConflictDoNothing();
	}
	const row = { id: newId("csh"), calendarId, granteeUserId: targetId, role: input.role, createdByUserId: actor.id, createdAt: now };
	try { await db.insert(calendarShares).values(row); } catch (error) {
		if (isUniqueConstraintError(error)) return fail(409, "This calendar is already shared with that person", "ALREADY_SHARED");
		throw error;
	}
	// The count and the insert are not one step; give the place back when a concurrent grant took the last one.
	if (await countShares(db, calendarId) > MAX_SHARES) {
		await db.delete(calendarShares).where(eq(calendarShares.id, row.id));
		return fail(409, `A calendar can be shared with up to ${MAX_SHARES} people`, "SHARE_LIMIT");
	}
	return { ok: true, ownerId: access.ownerId, share: await shareEntry(db, row) };
}

/**
 * A role change deletes the grant and inserts a new one under a new id, in one batch (D-5): phones see a new collection and
 * resync, so a full body cached under a higher role is dropped. A change to the role the grant already has changes nothing.
 */
export async function changeShare(db: Db, actor: Actor, calendarId: string, input: { id?: unknown; role?: unknown }): Promise<ShareChangeResult> {
	const access = await requireManager(db, actor, calendarId);
	if (isFailure(access)) return access;
	if (typeof input.id !== "string" || !isGrantRole(input.role)) return fail(400, "Choose a role");
	const [existing] = await db.select().from(calendarShares).where(and(eq(calendarShares.id, input.id), eq(calendarShares.calendarId, calendarId))).limit(1);
	if (!existing || !existing.granteeUserId) return fail(404, "Share not found");
	if (RANK[input.role] > RANK[access.role] || RANK[existing.role] > RANK[access.role]) return fail(403, "You cannot give more access than you have");
	if (existing.role === input.role) return { ok: true, ownerId: access.ownerId, share: await shareEntry(db, existing), previousRole: existing.role };
	const row = { id: newId("csh"), calendarId, granteeUserId: existing.granteeUserId, role: input.role, createdByUserId: actor.id, createdAt: new Date() };
	await db.batch([db.delete(calendarShares).where(eq(calendarShares.id, existing.id)), db.insert(calendarShares).values(row)] as never);
	return { ok: true, ownerId: access.ownerId, share: await shareEntry(db, row), previousRole: existing.role };
}

/** Revoking deletes the row; the next request from the former grantee finds no role (nothing is cached server side). */
export async function revokeShare(db: Db, actor: Actor, calendarId: string, shareId: unknown): Promise<ShareRevokeResult> {
	const access = await requireManager(db, actor, calendarId);
	if (isFailure(access)) return access;
	if (typeof shareId !== "string" || !shareId) return fail(400, "Missing share");
	const [existing] = await db.select().from(calendarShares).where(and(eq(calendarShares.id, shareId), eq(calendarShares.calendarId, calendarId))).limit(1);
	if (!existing) return fail(404, "Share not found");
	if (RANK[existing.role] > RANK[access.role]) return fail(403, "You cannot remove access above your own");
	const entry = await shareEntry(db, existing);
	await db.delete(calendarShares).where(and(eq(calendarShares.id, existing.id), eq(calendarShares.calendarId, calendarId)));
	return { ok: true, ownerId: access.ownerId, share: entry };
}

// ---- Writing into a calendar ----------------------------------------------------------------------------------------

export type WriteTarget =
	| { ok: true; calendarId: string | null | undefined; ownerId: string; role: CalendarRole }
	| { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Where an event write goes and as whom (D-2). Undefined `calendarId` means "leave it where it is" (PATCH) and null the owner's
 * default calendar; `ownerId` is the user id the row carries, which is the calendar's owner, never the actor. Writing needs
 * `edit`: a calendar with no role (or free/busy only, which is not listed) is "not found", one the actor can see but not
 * change is 403. `current` is the event being edited: it never moves to another person's calendar (D-2 keeps one owner per
 * row, and cross-owner moves are refused), and naming the calendar it is already in changes nothing.
 */
export async function resolveCalendarForWrite(db: Db, user: Actor, requested: unknown, current?: { ownerId: string; calendarId: string | null }): Promise<WriteTarget> {
	if (requested === undefined) return current ? { ok: true, calendarId: undefined, ownerId: current.ownerId, role: "owner" } : { ok: true, calendarId: null, ownerId: user.id, role: "owner" };
	if (requested !== null && typeof requested !== "string") return { ok: false, status: 400, error: "Invalid calendar" };
	const target = requested ?? calendarCollectionId(user.id);
	if (current && target === (current.calendarId ?? calendarCollectionId(current.ownerId))) return { ok: true, calendarId: undefined, ownerId: current.ownerId, role: "owner" };
	const access = await getCalendarAccess(db, user, target);
	if (!access || access.role === "freebusy") return { ok: false, status: 404, error: "Calendar not found" };
	if (!roleAtLeast(access.role, "edit")) return { ok: false, status: 403, error: "You can only view this calendar" };
	if (current && access.ownerId !== current.ownerId) return { ok: false, status: 400, error: "Events cannot move to another person's calendar" };
	return { ok: true, calendarId: target === calendarCollectionId(access.ownerId) ? null : target, ownerId: access.ownerId, role: access.role };
}

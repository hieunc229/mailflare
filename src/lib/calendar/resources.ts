import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, calendarResourceBookings, calendarResources } from "@/db/schema";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { newId } from "@/lib/ids";
import type { BookableRooms, ResourceDeleteResult, ResourceFailure, ResourceResult, ResourceSummary } from "./resources-types";

type Db = ReturnType<typeof getDb>;

/** Spec F9 section 5: resources per installation, and rooms per event. */
export const MAX_RESOURCES = 500;
export const MAX_EVENT_RESOURCES = 5;
export const MAX_RESOURCE_NAME = 120;
export const MAX_RESOURCE_LOCATION = 200;
export const MAX_RESOURCE_DESCRIPTION = 1000;
export const MAX_CAPACITY = 100_000;
/** Event ids a forced delete reports back (the audit entry and the response stay small). */
const MAX_REPORTED_EVENTS = 200;
const IDS_CHUNK = 90;

const fail = (status: ResourceFailure["status"], error: string, code?: ResourceFailure["code"]): ResourceFailure => ({ ok: false, status, error, ...(code ? { code } : {}) });
const select = { id: calendarResources.id, name: calendarResources.name, kind: calendarResources.kind, capacity: calendarResources.capacity, location: calendarResources.location, description: calendarResources.description, disabled: calendarResources.disabled };
const hasOwn = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);

type Fields = Partial<Pick<ResourceSummary, "name" | "kind" | "capacity" | "location" | "description" | "disabled">>;

/** The fields a request names, checked and trimmed. A field left out stays out (a create fills the defaults, an update keeps the stored value). */
function parseFields(body: Record<string, unknown>): Fields | ResourceFailure {
	const fields: Fields = {};
	if (hasOwn(body, "name")) {
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name || name.length > MAX_RESOURCE_NAME) return fail(400, `Enter a name of up to ${MAX_RESOURCE_NAME} characters`);
		fields.name = name;
	}
	if (hasOwn(body, "kind")) {
		if (body.kind !== "room" && body.kind !== "equipment") return fail(400, "Choose room or equipment");
		fields.kind = body.kind;
	}
	if (hasOwn(body, "capacity")) {
		if (body.capacity !== null && !(typeof body.capacity === "number" && Number.isInteger(body.capacity) && body.capacity >= 1 && body.capacity <= MAX_CAPACITY)) return fail(400, `Capacity is a whole number from 1 to ${MAX_CAPACITY}, or empty`);
		fields.capacity = body.capacity as number | null;
	}
	for (const [key, limit] of [["location", MAX_RESOURCE_LOCATION], ["description", MAX_RESOURCE_DESCRIPTION]] as const) {
		if (!hasOwn(body, key)) continue;
		const value = body[key];
		if (typeof value !== "string" || value.trim().length > limit) return fail(400, `${key === "location" ? "Location" : "Description"} is text of up to ${limit} characters`);
		fields[key] = value.trim();
	}
	if (hasOwn(body, "disabled")) {
		if (typeof body.disabled !== "boolean") return fail(400, "disabled is true or false");
		fields.disabled = body.disabled;
	}
	return fields;
}

const isFailure = (value: Fields | ResourceFailure): value is ResourceFailure => "ok" in value;

/** Every resource, by name; pickers pass `includeDisabled: false`. */
export async function listResources(db: Db, options: { includeDisabled: boolean }): Promise<ResourceSummary[]> {
	return db.select(select).from(calendarResources).where(options.includeDisabled ? undefined : eq(calendarResources.disabled, false)).orderBy(asc(calendarResources.name)).limit(MAX_RESOURCES + 1);
}

/** Names are unique ignoring case; the unique index only catches the exact spelling. */
async function nameTaken(db: Db, name: string, exceptId?: string): Promise<boolean> {
	const same = sql`lower(${calendarResources.name}) = ${name.toLowerCase()}`;
	return (await db.select({ id: calendarResources.id }).from(calendarResources).where(exceptId ? and(same, ne(calendarResources.id, exceptId)) : same).limit(1)).length > 0;
}

export async function createResource(db: Db, actorId: string, body: Record<string, unknown>): Promise<ResourceResult> {
	if (!hasOwn(body, "name")) return fail(400, "Enter a name");
	const fields = parseFields(body);
	if (isFailure(fields)) return fields;
	if (Number((await db.select({ n: count() }).from(calendarResources))[0].n) >= MAX_RESOURCES) return fail(409, `An installation can have up to ${MAX_RESOURCES} rooms and resources`, "RESOURCE_LIMIT");
	if (await nameTaken(db, fields.name!)) return fail(409, "A room or resource with that name already exists", "NAME_TAKEN");
	const now = new Date();
	const resource: ResourceSummary = { id: newId("res"), name: fields.name!, kind: fields.kind ?? "room", capacity: fields.capacity ?? null, location: fields.location ?? "", description: fields.description ?? "", disabled: fields.disabled ?? false };
	try { await db.insert(calendarResources).values({ ...resource, createdByUserId: actorId, createdAt: now, updatedAt: now }); } catch (error) {
		if (isUniqueConstraintError(error)) return fail(409, "A room or resource with that name already exists", "NAME_TAKEN");
		throw error;
	}
	return { ok: true, resource };
}

export async function updateResource(db: Db, body: Record<string, unknown>): Promise<ResourceResult> {
	if (typeof body.id !== "string" || !body.id) return fail(400, "Missing id");
	const fields = parseFields(body);
	if (isFailure(fields)) return fail(fields.status, fields.error);
	const [existing] = await db.select(select).from(calendarResources).where(eq(calendarResources.id, body.id)).limit(1);
	if (!existing) return fail(404, "Room not found");
	if (fields.name !== undefined && await nameTaken(db, fields.name, existing.id)) return fail(409, "A room or resource with that name already exists", "NAME_TAKEN");
	try { await db.update(calendarResources).set({ ...fields, updatedAt: new Date() }).where(eq(calendarResources.id, existing.id)); } catch (error) {
		if (isUniqueConstraintError(error)) return fail(409, "A room or resource with that name already exists", "NAME_TAKEN");
		throw error;
	}
	return { ok: true, resource: { ...existing, ...fields } };
}

/** Accepted bookings whose event still has an occurrence ahead: it ends later, or it repeats with no end or an end in the future. */
const upcoming = (now: Date) => and(eq(calendarResourceBookings.status, "accepted"), or(gt(calendarEvents.endsAt, now), and(ne(calendarEvents.repeat, "none"), or(isNull(calendarEvents.repeatUntil), gt(calendarEvents.repeatUntil, now)))));

/**
 * Deletes a room. While events still have it booked ahead that is refused (409 HAS_BOOKINGS, with the count), unless `force`: the
 * bookings go with the room, the events stay (they just lose the room) and their ids come back so the caller can say which.
 */
export async function deleteResource(db: Db, id: unknown, force: boolean, options: { now?: Date } = {}): Promise<ResourceDeleteResult> {
	if (typeof id !== "string" || !id) return fail(400, "Missing id");
	const [existing] = await db.select({ id: calendarResources.id, name: calendarResources.name }).from(calendarResources).where(eq(calendarResources.id, id)).limit(1);
	if (!existing) return fail(404, "Room not found");
	const ahead = await db.select({ eventId: calendarResourceBookings.eventId }).from(calendarResourceBookings)
		.innerJoin(calendarEvents, eq(calendarEvents.id, calendarResourceBookings.eventId))
		.where(and(eq(calendarResourceBookings.resourceId, id), upcoming(options.now ?? new Date()))).limit(MAX_REPORTED_EVENTS + 1);
	if (ahead.length && !force) return { ...fail(409, "Events still have this room booked", "HAS_BOOKINGS"), bookings: ahead.length };
	// One batch: a booking made while this runs is removed with the room rather than left pointing at nothing (the cascade does it on every dialect).
	await db.batch([db.delete(calendarResourceBookings).where(eq(calendarResourceBookings.resourceId, id)), db.delete(calendarResources).where(eq(calendarResources.id, id))] as never);
	return { ok: true, name: existing.name, eventIds: ahead.slice(0, MAX_REPORTED_EVENTS).map((row) => row.eventId), bookings: ahead.length };
}

/**
 * The rooms an event save may book (D-13): a list of at most five distinct, known ids. A disabled room cannot be newly booked and a
 * room is only newly booked with a Team licence (`canBook`); a room the event already has stays whatever the licence or switch says,
 * and removing rooms is always possible.
 */
export async function resolveBookableRooms(db: Db, requested: unknown, options: { booked: string[]; canBook: boolean }): Promise<BookableRooms> {
	if (!Array.isArray(requested) || !requested.every((id) => typeof id === "string")) return fail(400, "resourceIds must be a list of ids");
	const ids = [...new Set(requested as string[])];
	if (ids.length > MAX_EVENT_RESOURCES) return fail(400, `An event can book at most ${MAX_EVENT_RESOURCES} rooms`, "TOO_MANY_ROOMS");
	if (!ids.length) return { ok: true, ids };
	const rows = await db.select({ id: calendarResources.id, disabled: calendarResources.disabled }).from(calendarResources).where(inArray(calendarResources.id, ids.slice(0, IDS_CHUNK)));
	const known = new Map(rows.map((row) => [row.id, row.disabled]));
	const added = ids.filter((id) => !options.booked.includes(id));
	if (ids.some((id) => !known.has(id))) return fail(400, "One of those rooms does not exist", "ROOM_UNKNOWN");
	if (added.length && !options.canBook) return fail(403, "Booking rooms needs a Team licence", "TEAM_REQUIRED");
	if (added.some((id) => known.get(id))) return fail(400, "One of those rooms is turned off", "ROOM_UNKNOWN");
	return { ok: true, ids };
}

import { and, eq, inArray, ne, not, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, calendarEvents, calendarShares, davCalendarObjects, davChanges } from "@/db/schema";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { isConsistentRepeat } from "@/lib/calendar/repeat-fields";
import { OFF_CALENDAR_RESPONSES } from "@/lib/calendar/response-status";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { newId } from "@/lib/ids";
import { auditLogRow } from "@/lib/mailboxes/audit";
import { roleAtLeast } from "@/lib/calendar/shares";
import { rowsHash } from "./calendar-merge";
import { parseCalendarObject, type EventFields } from "./calendar-parse";
import { calendarBytes, findCalendarByName, findUidConflict, withOverrides } from "./calendar-store";
import type { EventRow } from "./calendar-render";
import { calendarExistsGuard } from "@/lib/calendar/calendars";
import { collectionScope, etagFromSeq, etagSeqs } from "./changes";
import { BASE_HEADERS, needPrivileges, precondition, text, XML_HEADERS } from "./common";
import { calendarOf, pathOf, type DavContext } from "./collections";
import { escapeXml } from "./xml-writer";
import { created, failedPrecondition, insufficientStorage, MAX_CALENDAR_BYTES, readPutBody, replaced, requireGuard, staleGuard } from "./writes";

/** Rows per insert: 25 bound values each, so three stay under D1's 100 bound parameters. */
const ROWS_PER_INSERT = 3;

/** A row's mapped columns as the insert and update statements write them. */
const columns = (fields: EventFields, now: Date) => ({
	title: fields.title,
	description: fields.description,
	location: fields.location,
	attendees: fields.attendees,
	attendeeResponses: fields.attendeeResponses,
	startsAt: fields.startsAt,
	endsAt: fields.endsAt,
	allDay: fields.allDay,
	timeZone: fields.timeZone,
	isPrivate: fields.isPrivate,
	transparent: fields.transparent,
	updatedAt: now,
});

/** RFC 4791 5.3.2.1: the UID is taken by another resource, whose href goes in the error. */
const conflict = (href: string) =>
	new Response(`<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:no-uid-conflict><D:href>${escapeXml(href)}</D:href></C:no-uid-conflict></D:error>`, { status: 403, headers: XML_HEADERS });

/** The guests of a stored or parsed list as a comparable set (the same address in any case or order is the same guest). */
function guestSet(raw: string | null): string {
	try {
		const list: unknown = JSON.parse(raw || "[]");
		return Array.isArray(list) ? [...new Set(list.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toLowerCase()))].sort().join(",") : "";
	} catch {
		return "";
	}
}

/**
 * Statements that go first in a delegate's write batch: it fails when the calendar is gone or the grant has been revoked (or
 * lowered below `edit`) since the request's role check, and the request ends as a failed precondition. A revoke takes effect at the
 * next request; this closes the gap inside one.
 */
const writeGuards = (db: ReturnType<typeof getDb>, ctx: DavContext) => {
	const calendar = calendarOf(ctx);
	return [
		...(calendar.isDefault ? [] : calendarExistsGuard(db, calendar.ownerId, calendar.id)),
		...(calendar.grantId ? requireGuard(db, not(sql`exists (select 1 from ${calendarShares} where ${and(eq(calendarShares.id, calendar.grantId), eq(calendarShares.granteeUserId, ctx.userId), inArray(calendarShares.role, ["edit", "manage"]))})`)!) : []),
	];
};

/** What a delegate's write is recorded as (D-14), written in the batch that makes the change: no change without its record. The owner's own writes are not audited. */
const delegateAudit = (db: ReturnType<typeof getDb>, ctx: DavContext, action: "created" | "updated" | "deleted", eventId: string) =>
	db.insert(auditLogs).values(auditLogRow({ actorUserId: ctx.userId, targetUserId: calendarOf(ctx).ownerId, action: `calendar.event_${action}_by_delegate`, metadata: { calendarId: calendarOf(ctx).id, eventId } }));

/**
 * PUT of one calendar resource (spec 7.2). The body is read under the size cap, parsed with bounded work, checked against
 * If-Match / If-None-Match, the UID rules and the user's storage limit, then written in one atomic batch that starts with the
 * guard of `staleGuard` (the resource must still be as it was read, else the batch fails and the answer is 412): the old
 * override rows go, the master row is inserted or updated, the new override rows are inserted in chunks, the stored body and
 * the hash of the rows it maps to are written, and the last statement reads the resource's newest change number, which is
 * its ETag. At most 20 statements. The change-log triggers record every row written, so the write moves the ETag and the
 * sync token like any other edit.
 */
export async function putCalendarResource(ctx: DavContext, name: string, request: Request, addresses: () => Promise<string[]>): Promise<Response> {
	if (!roleAtLeast(calendarOf(ctx).role, "edit")) return needPrivileges(pathOf("calendars", ctx) + name, "write-content");
	const body = await readPutBody(request, ["text/calendar"]);
	if (body instanceof Response) return body;
	const parsed = parseCalendarObject(body, ctx.timeZone, await addresses());
	if ("error" in parsed) return precondition(403, parsed.error, "C");

	const { env } = ctx;
	// The rows are the calendar owner's, whoever writes (D-2); the collection says which calendar they are in.
	const calendar = calendarOf(ctx);
	const { id: cid, ownerId: userId } = calendar;
	// An editor or manager writes the owner's rows (D-2) and never changes who is invited, answers for the owner or sends mail (v1, spec Non-goals).
	const delegate = calendar.role !== "owner";
	const atName = await findCalendarByName(env, calendar, name);
	const atNameSeq = atName ? (await etagSeqs(env, cid, [atName.id])).get(atName.id) : undefined;
	const refused = failedPrecondition(request, atName ? etagFromSeq(atNameSeq, atName.master.updatedAt) : null);
	if (refused) return refused;
	const other = await findUidConflict(env, calendar, parsed.uid, atName?.id ?? null);
	const hidden = !!other && !!other.master.responseStatus && (OFF_CALENDAR_RESPONSES as readonly string[]).includes(other.master.responseStatus);
	if (other && !hidden) return conflict(pathOf("calendars", ctx) + other.name);
	// A resource keeps its UID (RFC 4791 5.3.2.1): the one at this name is refused a different one, with its own href.
	if (atName && atName.uid !== parsed.uid) return conflict(pathOf("calendars", ctx) + atName.name);
	// The UID is held by a hidden (cancelled, declined) resource, which a client cannot see or name: the new name takes it over.
	const existing = atName ?? other;
	const seq = existing === atName ? atNameSeq : existing ? (await etagSeqs(env, cid, [existing.id])).get(existing.id) : undefined;
	if (delegate && existing) await withOverrides(env, calendar, [existing]);
	const storedOverride = (at: Date) => existing?.overrides.find((row) => row.recurrenceId?.getTime() === at.getTime());
	// The guest list is the owner's. A body with no guests is what a phone sends for an event it was served without them (a delegate's body is generated
	// without ATTENDEE lines), so it keeps the stored list; a body that names guests must name exactly the stored ones. An occurrence the delegate moves
	// has the series' guests. Either way the stored list is saved as it is, byte for byte.
	const referenceFor = (at: Date | null): EventRow | undefined => (at ? storedOverride(at) : undefined) ?? existing?.master;
	if (delegate && [{ fields: parsed.master as EventFields, at: null as Date | null }, ...parsed.overrides.map((fields) => ({ fields: fields as EventFields, at: fields.recurrenceId as Date | null }))].some(({ fields, at }) => guestSet(fields.attendees) !== "" && guestSet(fields.attendees) !== guestSet(referenceFor(at)?.attendees ?? null))) return precondition(403, "valid-calendar-object-resource", "C");
	const owned = <T extends EventFields>(fields: T, stored: EventRow | undefined): T => (delegate ? { ...fields, attendees: stored?.attendees ?? "[]", attendeeResponses: stored?.attendeeResponses ?? null, responseStatus: stored?.responseStatus ?? null, inviteSender: stored?.inviteSender ?? null } : fields);
	// A delegate's text is not what is stored (below), so it neither counts against the owner's quota nor changes the size of what the owner's phone has.
	const size = delegate ? (existing?.size ?? 0) : new TextEncoder().encode(body).byteLength;
	const oldSize = existing?.size ?? 0;
	if (size > oldSize && (await calendarBytes(env, userId)) - oldSize + size > MAX_CALENDAR_BYTES) return insufficientStorage("The calendar");

	const now = new Date(Math.floor(Date.now() / 1000) * 1000);
	const id = existing?.id ?? newId("evt");
	const old = existing?.master;
	const master = owned(parsed.master, old);
	const status = master.responseStatus ?? (old?.inviteMessageId ? old.responseStatus : null);
	const masterColumns = {
		...columns(master, now),
		repeat: parsed.master.repeat,
		repeatDays: parsed.master.repeatDays,
		repeatAnchorDay: parsed.master.repeatAnchorDay,
		repeatUntil: parsed.master.repeatUntil,
		rrule: parsed.master.rrule,
		excludedOccurrences: JSON.stringify(parsed.master.excludedOccurrences),
		responseStatus: status,
		inviteSender: master.inviteSender ?? old?.inviteSender ?? null,
		recurrenceId: null,
		davObjectId: id,
	};
	const color = old?.color ?? normalizeCalendarColor(undefined);
	const overrideRows = parsed.overrides.map((source) => {
		const fields = owned(source, referenceFor(source.recurrenceId));
		return {
			...columns(fields, now),
			id: newId("evt"),
			userId,
			color,
			repeat: "none" as const,
			repeatDays: "[]",
			repeatAnchorDay: null,
			repeatUntil: null,
			rrule: null,
			excludedOccurrences: "[]",
			responseStatus: fields.responseStatus,
			recurrenceId: fields.recurrenceId,
			davObjectId: id,
			// An override lives in its master's calendar, or a series with a moved master would be split across calendars.
			calendarId: old ? old.calendarId : calendar.isDefault ? null : cid,
			createdAt: now,
		};
	});
	// The rows as they will be read back, for the hash the stored body is valid against.
	const masterRow = { ...(old ?? { reminderMinutes: null, color }), ...masterColumns, id, userId } as EventRow;
	if (!isConsistentRepeat(masterRow)) return precondition(403, "valid-calendar-object-resource", "C");
	const hash = await rowsHash(masterRow, overrideRows.map((row) => ({ ...row, reminderMinutes: null }) as unknown as EventRow));

	const db = getDb(env);
	const scope = [cid];
	// A delegate's text is never kept as the resource's body: it carries the delegate's own PARTSTAT, ORGANIZER and alarms, which the owner's phone
	// would take as the owner's. The previous body stays (its hash cleared, so the rows' mapped properties are merged into it on the next read).
	const objectValues = delegate ? { uid: parsed.uid, name, rowsHash: null, size, updatedAt: now } : { uid: parsed.uid, name, body, rowsHash: hash, size, updatedAt: now };
	// A calendar deleted meanwhile refuses the batch instead of taking rows for a collection that is gone.
	const statements: unknown[] = [...writeGuards(db, ctx), ...(existing ? staleGuard(db, calendarEvents, scope, id, userId, { seq: seq ?? null, updatedAt: existing.master.updatedAt }) : [])];
	if (old?.davObjectId === id) statements.push(db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.davObjectId, id), ne(calendarEvents.id, id))));
	statements.push(existing ? db.update(calendarEvents).set(masterColumns).where(and(eq(calendarEvents.id, id), eq(calendarEvents.userId, userId))) : db.insert(calendarEvents).values({ ...masterColumns, id, userId, color, calendarId: calendar.isDefault ? null : cid, createdAt: now }));
	for (let i = 0; i < overrideRows.length; i += ROWS_PER_INSERT) statements.push(db.insert(calendarEvents).values(overrideRows.slice(i, i + ROWS_PER_INSERT)));
	// A native event written for the first time has no stored resource yet.
	const hasObject = (await db.select({ id: davCalendarObjects.id }).from(davCalendarObjects).where(eq(davCalendarObjects.id, id)).limit(1)).length > 0;
	statements.push(hasObject ? db.update(davCalendarObjects).set(objectValues).where(eq(davCalendarObjects.id, id)) : db.insert(davCalendarObjects).values({ ...objectValues, body: delegate ? null : body, id, userId, collectionId: cid, createdAt: now }));
	if (delegate) statements.push(delegateAudit(db, ctx, existing ? "updated" : "created", id));
	statements.push(db.select({ seq: sql<number | null>`max(${davChanges.seq})` }).from(davChanges).where(and(collectionScope(davChanges.collectionId, scope), eq(davChanges.objectKey, id))));
	let results: unknown[];
	try {
		results = (await db.batch(statements as never)) as unknown[];
	} catch (error) {
		// Two writes raced for the same name or UID; the loser is refused like a failed precondition.
		if (isUniqueConstraintError(error)) return text(412, "Precondition failed");
		throw error;
	}
	const [last] = results[results.length - 1] as { seq: number | null }[];
	const etag = etagFromSeq(last?.seq, now);
	// What a delegate sent is not what the server keeps (RFC 4791 5.3.4): no ETag, the client fetches the resource to learn it.
	if (delegate) return new Response(null, { status: atName ? 204 : 201, headers: BASE_HEADERS });
	return atName ? replaced(etag) : created(etag);
}

/** DELETE of one calendar resource: the master row and its override rows in one statement, guarded like a PUT (the stored body goes with the master by cascade). */
export async function deleteCalendarResource(ctx: DavContext, name: string, request: Request): Promise<Response> {
	const calendar = calendarOf(ctx);
	if (!roleAtLeast(calendar.role, "edit")) return needPrivileges(pathOf("calendars", ctx) + name, "unbind");
	const cid = calendar.id;
	const existing = await findCalendarByName(ctx.env, calendar, name);
	const seq = existing ? (await etagSeqs(ctx.env, cid, [existing.id])).get(existing.id) : undefined;
	const refused = failedPrecondition(request, existing ? etagFromSeq(seq, existing.master.updatedAt) : null);
	if (refused) return refused;
	if (!existing) return text(404, "Not found");
	const db = getDb(ctx.env);
	try {
		await db.batch([...writeGuards(db, ctx), ...staleGuard(db, calendarEvents, [cid], existing.id, calendar.ownerId, { seq: seq ?? null, updatedAt: existing.master.updatedAt }), ...(calendar.role !== "owner" ? [delegateAudit(db, ctx, "deleted", existing.id)] : []), db.delete(calendarEvents).where(and(eq(calendarEvents.userId, calendar.ownerId), or(eq(calendarEvents.id, existing.id), eq(calendarEvents.davObjectId, existing.id))))] as never);
	} catch (error) {
		// Changed or removed since it was read.
		if (isUniqueConstraintError(error)) return text(412, "Precondition failed");
		throw error;
	}
	return new Response(null, { status: 204, headers: BASE_HEADERS });
}

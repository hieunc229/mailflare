import { and, eq, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, davCalendarObjects, davChanges } from "@/db/schema";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { isConsistentRepeat } from "@/lib/calendar/repeat-fields";
import { OFF_CALENDAR_RESPONSES } from "@/lib/calendar/response-status";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { newId } from "@/lib/ids";
import { rowsHash } from "./calendar-merge";
import { parseCalendarObject, type EventFields } from "./calendar-parse";
import { calendarBytes, findCalendarByName, findUidConflict } from "./calendar-store";
import type { EventRow } from "./calendar-render";
import { calendarCollectionId, collectionScope, etagFromSeq, etagSeqs } from "./changes";
import { BASE_HEADERS, precondition, text, XML_HEADERS } from "./common";
import { collectionPath, type DavContext } from "./collections";
import { escapeXml } from "./xml-writer";
import { created, failedPrecondition, insufficientStorage, MAX_CALENDAR_BYTES, readPutBody, replaced, staleGuard } from "./writes";

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
	updatedAt: now,
});

/** RFC 4791 5.3.2.1: the UID is taken by another resource, whose href goes in the error. */
const conflict = (href: string) =>
	new Response(`<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:no-uid-conflict><D:href>${escapeXml(href)}</D:href></C:no-uid-conflict></D:error>`, { status: 403, headers: XML_HEADERS });

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
	const body = await readPutBody(request, ["text/calendar"]);
	if (body instanceof Response) return body;
	const parsed = parseCalendarObject(body, ctx.timeZone, await addresses());
	if ("error" in parsed) return precondition(403, parsed.error, "C");

	const { env, userId } = ctx;
	const cid = calendarCollectionId(userId);
	const atName = await findCalendarByName(env, userId, name);
	const atNameSeq = atName ? (await etagSeqs(env, cid, [atName.id])).get(atName.id) : undefined;
	const refused = failedPrecondition(request, atName ? etagFromSeq(atNameSeq, atName.master.updatedAt) : null);
	if (refused) return refused;
	const other = await findUidConflict(env, userId, parsed.uid, atName?.id ?? null);
	const hidden = !!other && !!other.master.responseStatus && (OFF_CALENDAR_RESPONSES as readonly string[]).includes(other.master.responseStatus);
	if (other && !hidden) return conflict(collectionPath("calendars", userId) + other.name);
	// A resource keeps its UID (RFC 4791 5.3.2.1): the one at this name is refused a different one, with its own href.
	if (atName && atName.uid !== parsed.uid) return conflict(collectionPath("calendars", userId) + atName.name);
	// The UID is held by a hidden (cancelled, declined) resource, which a client cannot see or name: the new name takes it over.
	const existing = atName ?? other;
	const seq = existing === atName ? atNameSeq : existing ? (await etagSeqs(env, cid, [existing.id])).get(existing.id) : undefined;
	const size = new TextEncoder().encode(body).byteLength;
	const oldSize = existing?.size ?? 0;
	if (size > oldSize && (await calendarBytes(env, userId)) - oldSize + size > MAX_CALENDAR_BYTES) return insufficientStorage("The calendar");

	const now = new Date(Math.floor(Date.now() / 1000) * 1000);
	const id = existing?.id ?? newId("evt");
	const old = existing?.master;
	const status = parsed.master.responseStatus ?? (old?.inviteMessageId ? old.responseStatus : null);
	const masterColumns = {
		...columns(parsed.master, now),
		repeat: parsed.master.repeat,
		repeatDays: parsed.master.repeatDays,
		repeatAnchorDay: parsed.master.repeatAnchorDay,
		repeatUntil: parsed.master.repeatUntil,
		rrule: parsed.master.rrule,
		excludedOccurrences: JSON.stringify(parsed.master.excludedOccurrences),
		responseStatus: status,
		inviteSender: parsed.master.inviteSender ?? old?.inviteSender ?? null,
		recurrenceId: null,
		davObjectId: id,
	};
	const color = old?.color ?? normalizeCalendarColor(undefined);
	const overrideRows = parsed.overrides.map((fields) => ({
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
		calendarId: old?.calendarId ?? null,
		createdAt: now,
	}));
	// The rows as they will be read back, for the hash the stored body is valid against.
	const masterRow = { ...(old ?? { reminderMinutes: null, color }), ...masterColumns, id, userId } as EventRow;
	if (!isConsistentRepeat(masterRow)) return precondition(403, "valid-calendar-object-resource", "C");
	const hash = await rowsHash(masterRow, overrideRows.map((row) => ({ ...row, reminderMinutes: null }) as unknown as EventRow));

	const db = getDb(env);
	const objectValues = { uid: parsed.uid, name, body, rowsHash: hash, size, updatedAt: now };
	const statements: unknown[] = existing ? staleGuard(db, calendarEvents, cid, id, userId, { seq: seq ?? null, updatedAt: existing.master.updatedAt }) : [];
	if (old?.davObjectId === id) statements.push(db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.davObjectId, id), ne(calendarEvents.id, id))));
	statements.push(existing ? db.update(calendarEvents).set(masterColumns).where(and(eq(calendarEvents.id, id), eq(calendarEvents.userId, userId))) : db.insert(calendarEvents).values({ ...masterColumns, id, userId, color, createdAt: now }));
	for (let i = 0; i < overrideRows.length; i += ROWS_PER_INSERT) statements.push(db.insert(calendarEvents).values(overrideRows.slice(i, i + ROWS_PER_INSERT)));
	// A native event written for the first time has no stored resource yet.
	const hasObject = (await db.select({ id: davCalendarObjects.id }).from(davCalendarObjects).where(eq(davCalendarObjects.id, id)).limit(1)).length > 0;
	statements.push(hasObject ? db.update(davCalendarObjects).set(objectValues).where(eq(davCalendarObjects.id, id)) : db.insert(davCalendarObjects).values({ ...objectValues, id, userId, collectionId: cid, createdAt: now }));
	statements.push(db.select({ seq: sql<number | null>`max(${davChanges.seq})` }).from(davChanges).where(and(collectionScope(davChanges.collectionId, cid), eq(davChanges.objectKey, id))));
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
	return atName ? replaced(etag) : created(etag);
}

/** DELETE of one calendar resource: the master row and its override rows in one statement, guarded like a PUT (the stored body goes with the master by cascade). */
export async function deleteCalendarResource(ctx: DavContext, name: string, request: Request): Promise<Response> {
	const cid = calendarCollectionId(ctx.userId);
	const existing = await findCalendarByName(ctx.env, ctx.userId, name);
	const seq = existing ? (await etagSeqs(ctx.env, cid, [existing.id])).get(existing.id) : undefined;
	const refused = failedPrecondition(request, existing ? etagFromSeq(seq, existing.master.updatedAt) : null);
	if (refused) return refused;
	if (!existing) return text(404, "Not found");
	const db = getDb(ctx.env);
	try {
		await db.batch([...staleGuard(db, calendarEvents, cid, existing.id, ctx.userId, { seq: seq ?? null, updatedAt: existing.master.updatedAt }), db.delete(calendarEvents).where(and(eq(calendarEvents.userId, ctx.userId), or(eq(calendarEvents.id, existing.id), eq(calendarEvents.davObjectId, existing.id))))] as never);
	} catch (error) {
		// Changed or removed since it was read.
		if (isUniqueConstraintError(error)) return text(412, "Precondition failed");
		throw error;
	}
	return new Response(null, { status: 204, headers: BASE_HEADERS });
}

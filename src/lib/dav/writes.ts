import { and, eq, exists, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, davCards, davChanges, davSyncState } from "@/db/schema";
import { collectionScope } from "./changes";
import { readBodyText } from "./body";
import { BASE_HEADERS, etagListed, etagMatches, text } from "./common";

/** Largest PUT body (spec section 10). */
export const MAX_PUT_BODY = 1_048_576;
/** What one user may keep in each collection (owner ruling): stored calendar bodies and cards, in bytes. A write beyond it is 507. */
export const MAX_CALENDAR_BYTES = 50 * 1024 * 1024;
export const MAX_CARD_BYTES = 20 * 1024 * 1024;

/** 507 for a write that would take the user past a storage limit; shrinking a resource is never refused. */
export const insufficientStorage = (what: string) => text(507, `${what} is full`);

/**
 * The PUT body as text. The type must be one the collection takes (415) and the size is enforced while reading, not
 * only by Content-Length (413), before anything parses it.
 */
export async function readPutBody(request: Request, accepted: string[]): Promise<string | Response> {
	const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
	if (!accepted.includes(type)) return text(415, `Content-Type must be ${accepted[0]}`);
	const body = await readBodyText(request, MAX_PUT_BODY);
	return body === null ? text(413, "Resource too large") : body;
}

/**
 * The 412 a write owes when its If-Match / If-None-Match do not hold for the resource as it is now (`etag` null: there is
 * none). If-Match compares strongly, so a weak validator never matches; `If-Match: *` needs a resource. This is what keeps a
 * stale client from overwriting an edit made in Mailflare since it last synced.
 */
export function failedPrecondition(request: Request, etag: string | null): Response | null {
	const ifMatch = request.headers.get("If-Match");
	const ifNoneMatch = request.headers.get("If-None-Match");
	if (ifMatch !== null && (etag === null || !etagMatches(ifMatch, etag))) return text(412, "Precondition failed", etag ? { ETag: etag } : {});
	if (ifNoneMatch !== null && etag !== null && etagListed(ifNoneMatch, etag)) return text(412, "Precondition failed", { ETag: etag });
	return null;
}

export const created = (etag: string) => new Response(null, { status: 201, headers: { ...BASE_HEADERS, ETag: etag } });
export const replaced = (etag: string) => new Response(null, { status: 204, headers: { ...BASE_HEADERS, ETag: etag } });

type Db = ReturnType<typeof getDb>;
/** What a write read about the resource before its batch: the newest change number of its ETag (null: none, the `t<updatedAt>` fallback applies) and its update time. */
export type Seen = { seq: number | null; updatedAt: Date };

/**
 * The first statements of a write batch. Checking If-Match before the batch leaves a gap in which Mailflare (or another
 * client) can change the resource, and a batch cannot branch, so the batch checks again itself:
 *
 * 1. a no-op UPDATE of the resource's row, which takes its row lock on PostgreSQL and MySQL (the guard then reads what the
 *    competing write committed) and writes no change-log row (the triggers ignore an update that changes nothing);
 * 2. a two-row INSERT into `dav_sync_state` whose second key equals the first exactly when the resource is no longer
 *    there or its newest change number (or, without one, its update time) is not the one the request saw. The duplicate
 *    primary key fails the statement, so the whole batch rolls back; the caller maps that error to 412. A duplicate key is
 *    refused identically by SQLite, D1, PostgreSQL and MySQL in any SQL mode, unlike a NOT NULL violation, which
 *    non-strict MySQL turns into a default value;
 * 3. the removal of the two guard rows, when the guard passed.
 */
export function staleGuard(db: Db, table: typeof calendarEvents | typeof davCards, collectionIds: string[], id: string, userId: string, seen: Seen): unknown[] {
	const token = crypto.randomUUID();
	const [first, second] = [`guard:${token}:a`, `guard:${token}:b`];
	const there = exists(db.select({ one: sql`1` }).from(table).where(and(eq(table.id, id), eq(table.userId, userId), seen.seq === null ? eq(table.updatedAt, seen.updatedAt) : undefined)));
	const newest = sql`coalesce((select max(${davChanges.seq}) from ${davChanges} where ${and(collectionScope(davChanges.collectionId, collectionIds), eq(davChanges.objectKey, id))}), -1)`;
	const stale = sql`not (${there} and ${newest} = ${seen.seq ?? -1})`;
	return [
		db.update(table).set({ updatedAt: sql`${table.updatedAt}` } as never).where(and(eq(table.id, id), eq(table.userId, userId))),
		db.insert(davSyncState).values([
			{ collectionId: first, epoch: "guard", floor: 0 },
			{ collectionId: sql`case when ${stale} then ${first} else ${second} end` as unknown as string, epoch: "guard", floor: 0 },
		]),
		db.delete(davSyncState).where(inArray(davSyncState.collectionId, [first, second])),
	];
}

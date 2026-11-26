import { and, asc, eq, gt, inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { davChanges, davCollections, davSyncState } from "@/db/schema";
import { excluded, greatest } from "@/db/sql";
import { isMissingTableError } from "@/lib/database-errors";

/**
 * Reading side of the CalDAV/CardDAV change log. The log itself is written only by
 * the `dav_changes_*` triggers (migration 0102 and its PostgreSQL/MySQL twins), so
 * every writer of `calendar_events` and `dav_cards` is covered; never insert here.
 */

export const calendarCollectionId = (userId: string) => `cal:${userId}`;
export const addressBookCollectionId = (userId: string) => `card:${userId}`;

/**
 * The collection ids whose change-log rows make up `collectionId`'s log. The default calendar `cal:<user>` is what a phone sees
 * as `default/` and lists every event of the user, so its log covers all of the user's calendar collections (events in other
 * calendars are logged under their own collection ids by the triggers); any other collection is itself. Sequence numbers are
 * global, so one token and one ETag order changes across them. This holds until CalDAV serves each calendar as its own
 * collection (CS-4). One query, at most 50 ids (the calendar cap); readers match them with `IN (...)` so the
 * `(collection_id, seq)` index is used.
 */
export async function calendarScopeIds(env: Pick<CloudflareEnv, "DB">, collectionId: string): Promise<string[]> {
	if (!collectionId.startsWith("cal:")) return [collectionId];
	const rows = await getDb(env).select({ id: davCollections.id, userId: davCollections.userId }).from(davCollections)
		.where(and(eq(davCollections.kind, "calendar"), or(eq(davCollections.userId, collectionId.slice(4)), eq(davCollections.id, collectionId))));
	const self = rows.find((row) => row.id === collectionId);
	// A calendar that is not its owner's default one (`cal:<owner>`) is only itself.
	if (self && self.id !== calendarCollectionId(self.userId)) return [collectionId];
	return [...new Set([collectionId, ...rows.map((row) => row.id)])];
}

export const collectionScope = (column: AnyColumn, ids: string[]): SQL => (ids.length === 1 ? eq(column, ids[0]) : inArray(column, ids));

/** Rows older than this are pruned (the newest row of each live object is kept). Older sync tokens force a resync. */
export const CHANGE_RETENTION_DAYS = 30;
/** A sync-collection answer carries at most this many changes; more continue with a new token (RFC 6578 section 3.6). */
export const MAX_SYNC_CHANGES = 500;
/** Rows pruned per run, all of one collection. Under D1's 100 bound parameters, so the delete is one statement. */
const DELETE_CHUNK = 90;
export const MAX_PRUNED_PER_RUN = DELETE_CHUNK;

export type SyncToken = { collectionId: string; epoch: string; seq: number };

/** `https://<origin>/dav/sync/<collectionId>/<epoch>/<seq>`, used for both `DAV:sync-token` and `CS:getctag`. */
export function formatSyncToken(origin: string, collectionId: string, epoch: string, seq: number): string {
	return `${origin}/dav/sync/${encodeURIComponent(collectionId)}/${epoch}/${seq}`;
}

/** Null for anything that is not a token this module wrote. */
export function parseSyncToken(token: string): SyncToken | null {
	let url: URL;
	try {
		url = new URL(token);
	} catch {
		return null;
	}
	const parts = url.pathname.split("/");
	// ["", "dav", "sync", collection, epoch, seq]
	if (parts.length !== 6 || parts[1] !== "dav" || parts[2] !== "sync" || !/^[0-9]+$/.test(parts[5])) return null;
	let collectionId: string;
	try {
		collectionId = decodeURIComponent(parts[3]);
	} catch {
		return null;
	}
	const seq = Number(parts[5]);
	if (!collectionId || !parts[4] || !Number.isSafeInteger(seq)) return null;
	return { collectionId, epoch: parts[4], seq };
}

/** The collection's sync epoch and pruning floor (for the default calendar the highest among its scope); the epoch is generated on first use and never changes after. */
export async function ensureSyncState(env: Pick<CloudflareEnv, "DB">, collectionId: string, scope?: string[]): Promise<{ epoch: string; floor: number }> {
	const db = getDb(env);
	const ids = scope ?? await calendarScopeIds(env, collectionId);
	const floor = ids.length > 1 ? sql<number>`coalesce((select max(${davSyncState.floor}) from ${davSyncState} where ${collectionScope(davSyncState.collectionId, ids)}), 0)` : davSyncState.floor;
	const read = async () => (await db.select({ epoch: davSyncState.epoch, floor }).from(davSyncState).where(eq(davSyncState.collectionId, collectionId)).limit(1))[0];
	const existing = await read();
	if (existing) return { epoch: existing.epoch, floor: Number(existing.floor) };
	const [made] = await db.insert(davSyncState).values({ collectionId, epoch: crypto.randomUUID(), floor: 0 }).onConflictDoNothing().returning();
	// A collection with no siblings has floor 0 for the row just made; otherwise (or after losing the race) read it back.
	if (made && ids.length === 1) return { epoch: made.epoch, floor: 0 };
	const created = (await read())!;
	return { epoch: created.epoch, floor: Number(created.floor) };
}

/** The newest change position of the scope: the largest of each collection's own newest (an index lookup per collection), or the floor. */
async function newestSeq(env: Pick<CloudflareEnv, "DB">, ids: string[], floor: number): Promise<number> {
	const rows = await getDb(env).select({ seq: sql<number | null>`max(${davChanges.seq})` }).from(davChanges).where(collectionScope(davChanges.collectionId, ids)).groupBy(davChanges.collectionId);
	// After a prune an empty log still has a position: the floor, so the token handed out is never already stale.
	return Math.max(floor, ...rows.map((row) => Number(row.seq ?? 0)));
}

/** The epoch (created on first use, so a fresh collection has its state row before the position is taken) and the position to put in the collection's sync token / CTag right now. */
export async function syncPosition(env: Pick<CloudflareEnv, "DB">, collectionId: string): Promise<{ epoch: string; seq: number }> {
	const ids = await calendarScopeIds(env, collectionId);
	const { epoch, floor } = await ensureSyncState(env, collectionId, ids);
	return { epoch, seq: await newestSeq(env, ids, floor) };
}

/** Position to put in the collection's sync token / CTag right now. */
export async function currentSeq(env: Pick<CloudflareEnv, "DB">, collectionId: string): Promise<number> {
	return (await syncPosition(env, collectionId)).seq;
}

/** `name` is what a destroyed resource was served under (null for a native event, whose name is derived from its id). */
export type DavChange = { objectKey: string; type: "created" | "updated" | "destroyed"; name: string | null };
export type DavChanges = { changes: DavChange[]; hasMore: boolean; seq: number; epoch: string };

/**
 * Changes after `token`, newest change per object. `"invalid"` (answer 403 `valid-sync-token`, the client
 * resyncs) for a token of another collection or epoch, one below the pruning floor, or one ahead of the
 * log. The empty initial-sync token is not handled here: the log is pruned, so the caller lists live
 * resources and hands out `currentSeq`. `seq` is the position of the last change returned (the token to
 * continue from), or the token's own when nothing changed.
 */
export async function changesSince(env: Pick<CloudflareEnv, "DB">, collectionId: string, token: string): Promise<DavChanges | "invalid"> {
	const parsed = parseSyncToken(token);
	if (!parsed || parsed.collectionId !== collectionId) return "invalid";
	const ids = await calendarScopeIds(env, collectionId);
	const state = await ensureSyncState(env, collectionId, ids);
	const floor = Number(state.floor);
	if (parsed.epoch !== state.epoch || parsed.seq < floor) return "invalid";
	const rows = await getDb(env)
		.select({ seq: davChanges.seq, objectKey: davChanges.objectKey, type: davChanges.changeType, name: davChanges.resourceName })
		.from(davChanges)
		.where(and(collectionScope(davChanges.collectionId, ids), gt(davChanges.seq, parsed.seq)))
		.orderBy(asc(davChanges.seq))
		.limit(MAX_SYNC_CHANGES + 1);
	if (!rows.length && parsed.seq > (await newestSeq(env, ids, floor))) return "invalid";
	const hasMore = rows.length > MAX_SYNC_CHANGES;
	const page = hasMore ? rows.slice(0, MAX_SYNC_CHANGES) : rows;
	const latest = new Map<string, DavChange>();
	for (const row of page) latest.set(row.objectKey, { objectKey: row.objectKey, type: row.type, name: row.name ?? null });
	return {
		changes: [...latest.values()],
		hasMore,
		epoch: state.epoch,
		seq: page.length ? page[page.length - 1].seq : parsed.seq,
	};
}

/** ETag source: the newest change seq of each object. Chunked under D1's 100 bound parameters. */
export async function etagSeqs(env: Pick<CloudflareEnv, "DB">, collectionId: string, objectKeys: string[]): Promise<Map<string, number>> {
	const db = getDb(env);
	const ids = await calendarScopeIds(env, collectionId);
	// Keys and collection ids share D1's 100 bound parameters.
	const chunk = Math.max(10, Math.min(DELETE_CHUNK, 95 - ids.length));
	const result = new Map<string, number>();
	for (let i = 0; i < objectKeys.length; i += chunk) {
		const rows = await db
			.select({ key: davChanges.objectKey, seq: sql<number>`max(${davChanges.seq})` })
			.from(davChanges)
			.where(and(collectionScope(davChanges.collectionId, ids), inArray(davChanges.objectKey, objectKeys.slice(i, i + chunk))))
			.groupBy(davChanges.objectKey);
		for (const row of rows) result.set(row.key, Number(row.seq));
	}
	return result;
}

/** `"<seq>"`; a row the change log has no entry for (it should have one) falls back to its update time. */
export const etagFromSeq = (seq: number | null | undefined, updatedAt: Date) => `"${seq ?? `t${Math.floor(updatedAt.getTime() / 1000)}`}"`;

/** The newest change seq of the object with this key, as a column: lets a listing carry ETags without a second query. */
export const newestSeqOf = (collectionIds: string[], key: AnyColumn) =>
	sql<number | null>`(select max(${davChanges.seq}) from ${davChanges} where ${collectionScope(davChanges.collectionId, collectionIds)} and ${davChanges.objectKey} = ${key})`;

/**
 * Prune, run by the 5-minute cron. Removes rows older than 30 days except the newest row of each object
 * that still exists (ETags derive from it), raises the collection's floor to its highest pruned seq before
 * deleting, so a reader never sees a hole, and deletes by id (MySQL cannot delete with a subquery on the
 * same table). One collection and at most 90 rows per run, so at most 3 queries (about 26,000 rows a day);
 * the next run continues.
 */
export async function runDavChangeRetention(env: Pick<CloudflareEnv, "DB">, now: Date): Promise<number> {
	try {
		return await pruneDavChanges(env, now);
	} catch (error) {
		// Migration 0102 is applied later from Admin settings on some installations; nothing to prune before it.
		if (isMissingTableError(error)) return 0;
		throw error;
	}
}

async function pruneDavChanges(env: Pick<CloudflareEnv, "DB">, now: Date): Promise<number> {
	const db = getDb(env);
	const cutoff = Math.floor(now.getTime() / 1000) - CHANGE_RETENTION_DAYS * 86400;
	const rows = await db.all<{ seq: number; collection_id: string }>(sql`
		WITH prunable AS (
			SELECT c.seq AS seq, c.collection_id AS collection_id FROM dav_changes c
			WHERE c.created_at < ${cutoff}
			AND (c.change_type = 'destroyed' OR EXISTS (
				SELECT 1 FROM dav_changes n WHERE n.collection_id = c.collection_id AND n.object_key = c.object_key AND n.seq > c.seq)))
		SELECT seq, collection_id FROM prunable
		WHERE collection_id = (SELECT collection_id FROM prunable ORDER BY seq LIMIT 1)
		ORDER BY seq LIMIT ${MAX_PRUNED_PER_RUN}`);
	if (!rows.length) return 0;
	const seqs = rows.map((row) => Number(row.seq));
	await db
		.insert(davSyncState)
		.values({ collectionId: rows[0].collection_id, epoch: crypto.randomUUID(), floor: Math.max(...seqs) })
		.onConflictDoUpdate({ target: davSyncState.collectionId, set: { floor: greatest(sql`${davSyncState.floor}`, excluded(davSyncState.floor)) } });
	await db.delete(davChanges).where(inArray(davChanges.seq, seqs));
	return seqs.length;
}

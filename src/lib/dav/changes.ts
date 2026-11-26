import { and, eq, gt, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { davChanges, davSyncState } from "@/db/schema";
import { excluded, greatest } from "@/db/sql";
import { isMissingTableError } from "@/lib/database-errors";

/**
 * Reading side of the CalDAV/CardDAV change log. The log itself is written only by
 * the `dav_changes_*` triggers (migration 0102 and its PostgreSQL/MySQL twins), so
 * every writer of `calendar_events` and `dav_cards` is covered; never insert here.
 */

export const calendarCollectionId = (userId: string) => `cal:${userId}`;
export const addressBookCollectionId = (userId: string) => `card:${userId}`;

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

/**
 * A sync epoch. A calendar's is a version 8 (custom) UUID: until CalDAV served each calendar as its own collection (spec F9 CS-4) the
 * log of `default/` covered every calendar of the user, so a token from then must not be honoured now (the phone still holds events
 * that `default/` no longer lists). `ensureSyncState` replaces an older (random, version 4) calendar epoch by one of this kind, so the
 * old token is refused as an unknown epoch: the clean RFC 6578 403 `valid-sync-token` and a full resync (ETags are unchanged, so
 * nothing that is still the same is downloaded again). No migration is needed and the token keeps its shape.
 */
const newEpoch = (collectionId: string) => {
	const id = crypto.randomUUID();
	return collectionId.startsWith("cal:") ? `${id.slice(0, 14)}8${id.slice(15)}` : id;
};
const currentEpoch = (collectionId: string, epoch: string) => !collectionId.startsWith("cal:") || epoch[14] === "8";

/** The collection's sync epoch and pruning floor; the epoch is generated on first use and never changes after (but see `newEpoch`). */
export async function ensureSyncState(env: Pick<CloudflareEnv, "DB">, collectionId: string): Promise<{ epoch: string; floor: number }> {
	const db = getDb(env);
	const read = async () => (await db.select({ epoch: davSyncState.epoch, floor: davSyncState.floor }).from(davSyncState).where(eq(davSyncState.collectionId, collectionId)).limit(1))[0];
	let existing = await read();
	if (existing && !currentEpoch(collectionId, existing.epoch)) {
		// Conditional on the old value, so two requests renewing at once agree on the winner's epoch.
		await db.update(davSyncState).set({ epoch: newEpoch(collectionId) }).where(and(eq(davSyncState.collectionId, collectionId), eq(davSyncState.epoch, existing.epoch)));
		existing = await read();
	}
	if (existing) return { epoch: existing.epoch, floor: Number(existing.floor) };
	const [made] = await db.insert(davSyncState).values({ collectionId, epoch: newEpoch(collectionId), floor: 0 }).onConflictDoNothing().returning();
	if (made) return { epoch: made.epoch, floor: 0 };
	const created = (await read())!;
	return { epoch: created.epoch, floor: Number(created.floor) };
}

/** The newest change position of the collection (an index lookup), or the floor: after a prune an empty log still has a position, so the token handed out is never already stale. */
async function newestSeq(env: Pick<CloudflareEnv, "DB">, collectionId: string, floor: number): Promise<number> {
	const [row] = await getDb(env).select({ seq: sql<number | null>`max(${davChanges.seq})` }).from(davChanges).where(eq(davChanges.collectionId, collectionId));
	return Math.max(floor, Number(row?.seq ?? 0));
}

/** The epoch (created on first use, so a fresh collection has its state row before the position is taken) and the position to put in the collection's sync token / CTag right now. */
export async function syncPosition(env: Pick<CloudflareEnv, "DB">, collectionId: string): Promise<{ epoch: string; seq: number }> {
	const { epoch, floor } = await ensureSyncState(env, collectionId);
	return { epoch, seq: await newestSeq(env, collectionId, floor) };
}

/** Ids per statement when reading the positions of many collections: well under D1's 100 bound parameters. */
const POSITION_CHUNK = 90;
/** State rows per insert (three bound values each). */
const STATE_ROWS_PER_INSERT = 25;

/**
 * `syncPosition` for many collections in a handful of statements (a calendar home lists up to 550): the state rows in chunks, the
 * missing ones created together, and the newest change of each collection in one grouped read per chunk.
 */
export async function syncPositions(env: Pick<CloudflareEnv, "DB">, collectionIds: string[]): Promise<Map<string, { epoch: string; seq: number }>> {
	const db = getDb(env);
	const states = new Map<string, { epoch: string; floor: number }>();
	const readStates = async (ids: string[]) => {
		for (let i = 0; i < ids.length; i += POSITION_CHUNK) {
			for (const row of await db.select().from(davSyncState).where(inArray(davSyncState.collectionId, ids.slice(i, i + POSITION_CHUNK)))) states.set(row.collectionId, { epoch: row.epoch, floor: Number(row.floor) });
		}
	};
	await readStates(collectionIds);
	const stale = [...states].filter(([id, state]) => !currentEpoch(id, state.epoch));
	for (const [id, state] of stale) {
		await db.update(davSyncState).set({ epoch: newEpoch(id) }).where(and(eq(davSyncState.collectionId, id), eq(davSyncState.epoch, state.epoch)));
		states.delete(id);
	}
	const missing = collectionIds.filter((id) => !states.has(id));
	for (let i = 0; i < missing.length; i += STATE_ROWS_PER_INSERT) await db.insert(davSyncState).values(missing.slice(i, i + STATE_ROWS_PER_INSERT).map((collectionId) => ({ collectionId, epoch: newEpoch(collectionId), floor: 0 }))).onConflictDoNothing();
	// A concurrent request may have created a row first (its epoch wins), so what was missing is read back.
	if (missing.length) await readStates(missing);
	const newest = new Map<string, number>();
	for (let i = 0; i < collectionIds.length; i += POSITION_CHUNK) {
		const rows = await db.select({ id: davChanges.collectionId, seq: sql<number | null>`max(${davChanges.seq})` }).from(davChanges).where(inArray(davChanges.collectionId, collectionIds.slice(i, i + POSITION_CHUNK))).groupBy(davChanges.collectionId);
		for (const row of rows) newest.set(row.id, Number(row.seq ?? 0));
	}
	return new Map(collectionIds.map((id) => {
		const state = states.get(id)!;
		return [id, { epoch: state.epoch, seq: Math.max(state.floor, newest.get(id) ?? 0) }];
	}));
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
	const state = await ensureSyncState(env, collectionId);
	const floor = Number(state.floor);
	if (parsed.epoch !== state.epoch || parsed.seq < floor) return "invalid";
	const rows = await getDb(env)
		.select({ seq: davChanges.seq, objectKey: davChanges.objectKey, type: davChanges.changeType, name: davChanges.resourceName })
		.from(davChanges)
		.where(and(eq(davChanges.collectionId, collectionId), gt(davChanges.seq, parsed.seq)))
		// `seq + 0` is the same order but not the table's rowid order, so the planner reads the matching collections through
		// `dav_changes_collection_seq_idx` (and sorts that small result) instead of walking every user's rows after the token.
		.orderBy(sql`${davChanges.seq} + 0`)
		.limit(MAX_SYNC_CHANGES + 1);
	if (!rows.length && parsed.seq > (await newestSeq(env, collectionId, floor))) return "invalid";
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
	const chunk = DELETE_CHUNK;
	const result = new Map<string, number>();
	for (let i = 0; i < objectKeys.length; i += chunk) {
		const rows = await db
			.select({ key: davChanges.objectKey, seq: sql<number>`max(${davChanges.seq})` })
			.from(davChanges)
			.where(and(eq(davChanges.collectionId, collectionId), inArray(davChanges.objectKey, objectKeys.slice(i, i + chunk))))
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

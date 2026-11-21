import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { imapMessageCache } from "@/db/schema";
import { CACHE_PREFIX } from "./fetch";

const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 50;
/** D1 allows 100 bound parameters per statement. */
const LOOKUP_BATCH = 50;
/** Where a run that stopped before the end of the listing leaves the place the next run starts from. */
export const SWEEP_CURSOR_KEY = "imap-cache-state/sweep-cursor";

type SweepEnv = Pick<CloudflareEnv, "DB" | "BUCKET">;

async function readCursor(env: SweepEnv): Promise<string | undefined> {
	const object = await env.BUCKET.get(SWEEP_CURSOR_KEY);
	return object ? (await object.text()) || undefined : undefined;
}

/**
 * Deletes `imap-cache/` objects that no cache row points at: those of messages that
 * no longer exist (deleting a message cascades its cache row but not the object),
 * and those of an earlier version of a draft that was edited. It follows the pattern
 * of `sweepOrphanedRawMail`, with one difference: a run looks at up to
 * `PAGE * MAX_PAGES` objects, and when the listing is longer it stores where it
 * stopped, so the next run continues from there and every object is reached in
 * the end. Objects under a day old are left alone: an index writes the object
 * before its cache row. Returns how many it deleted.
 */
export async function sweepOrphanedImapCache(env: SweepEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	let removed = 0;
	let cursor = await readCursor(env);
	let finished = false;
	for (let page = 0; page < MAX_PAGES && !finished; page += 1) {
		let listing: Awaited<ReturnType<typeof env.BUCKET.list>>;
		try {
			listing = await env.BUCKET.list({ prefix: CACHE_PREFIX, cursor, limit: PAGE });
		} catch (error) {
			// A cursor the store no longer accepts: start over at the next run.
			if (!cursor) throw error;
			await env.BUCKET.delete(SWEEP_CURSOR_KEY);
			return removed;
		}
		const old = listing.objects.filter((object) => now.getTime() - object.uploaded.getTime() > MIN_AGE_MS && object.key.endsWith(".eml")).map((object) => object.key);
		const orphans: string[] = [];
		for (let index = 0; index < old.length; index += LOOKUP_BATCH) {
			const batch = old.slice(index, index + LOOKUP_BATCH);
			const referenced = await db.select({ key: imapMessageCache.synthKey }).from(imapMessageCache).where(inArray(imapMessageCache.synthKey, batch));
			const kept = new Set(referenced.map((row) => row.key));
			orphans.push(...batch.filter((key) => !kept.has(key)));
		}
		if (orphans.length) {
			await env.BUCKET.delete(orphans);
			removed += orphans.length;
		}
		cursor = listing.truncated ? listing.cursor : undefined;
		finished = !cursor;
	}
	if (cursor) await env.BUCKET.put(SWEEP_CURSOR_KEY, cursor);
	else await env.BUCKET.delete(SWEEP_CURSOR_KEY);
	return removed;
}

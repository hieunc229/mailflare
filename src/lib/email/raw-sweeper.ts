import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";

const PREFIX = "inbound/";
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 20;
/** D1 allows 100 bound parameters per statement. */
const LOOKUP_BATCH = 50;

/**
 * Deletes raw MIME under `inbound/` that no stored message refers to and that is old enough
 * that its queue message is long finished. This catches what the early-return cleanup in
 * `processInboundMessage` cannot: messages dropped after their final failed retry and
 * mail accepted for addresses that never resolved to a mailbox.
 */
export async function sweepOrphanedRawMail(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	let removed = 0;
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const listing = await env.BUCKET.list({ prefix: PREFIX, cursor, limit: PAGE });
		const old = listing.objects.filter((object) => now.getTime() - object.uploaded.getTime() > MIN_AGE_MS).map((object) => object.key);
		const orphans: string[] = [];
		for (let index = 0; index < old.length; index += LOOKUP_BATCH) {
			const batch = old.slice(index, index + LOOKUP_BATCH);
			const referenced = await db.select({ key: messages.rawR2Key }).from(messages).where(inArray(messages.rawR2Key, batch));
			const kept = new Set(referenced.map((row) => row.key));
			orphans.push(...batch.filter((key) => !kept.has(key)));
		}
		if (orphans.length) {
			await env.BUCKET.delete(orphans);
			removed += orphans.length;
		}
		if (!listing.truncated || !listing.cursor) break;
		cursor = listing.cursor;
	}
	return removed;
}

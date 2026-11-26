import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { findReferencedKeys } from "@/lib/drive/shared-objects";
import { INBOUND_SIGNATURE_MAX_AGE_SECONDS } from "@/lib/email/intake-signature";
import { SNS_MAX_AGE_MS } from "@/lib/aws/sns-signature";
import { UPLOAD_PREFIX } from "@/lib/jmap/blobs";
import { sweepStaleObjects } from "@/lib/email/stale-objects";
import { REQUEST_UPLOAD_PREFIX } from "@/lib/uploads/constants";

/** Raw MIME written by inbound delivery and by the import service. */
const RAW_PREFIXES = ["inbound/", "imports/"];
/** Message attachment objects; a Drive item saved from one keeps it alive (see findReferencedKeys). */
const ATTACHMENT_PREFIX = "attachments/";
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 20;
/**
 * Prefixes that only need an age-based sweep. The relay and SNS intake routes write one dedupe object per request
 * and accept timestamps up to their window in the past or future, so those are kept for twice the window plus an
 * hour of margin.
 */
const HOUR_MS = 60 * 60 * 1000;
const STALE_PREFIXES: Array<{ prefix: string; maxAgeMs: number }> = [
	{ prefix: "relay-seen/", maxAgeMs: 2 * INBOUND_SIGNATURE_MAX_AGE_SECONDS * 1000 + HOUR_MS },
	{ prefix: "sns-seen/", maxAgeMs: 2 * SNS_MAX_AGE_MS + HOUR_MS },
	// JMAP uploads an Email/set create has claimed are copied into the draft; unclaimed ones are abandoned.
	{ prefix: `${UPLOAD_PREFIX}/`, maxAgeMs: 7 * 24 * HOUR_MS },
	// Direct uploads (Vercel) are deleted once their request reads them; the rest were abandoned.
	{ prefix: `${REQUEST_UPLOAD_PREFIX}/`, maxAgeMs: 24 * HOUR_MS },
];
/** D1 allows 100 bound parameters per statement. */
const LOOKUP_BATCH = 50;

/**
 * Deletes objects under `prefix` that are older than a day and that `kept` does not claim. Listing is by key,
 * so a run looks at a bounded number of pages and the next scheduled run picks up the rest.
 */
async function sweepUnreferenced(
	env: CloudflareEnv,
	prefix: string,
	now: Date,
	kept: (keys: string[]) => Promise<Set<string>>,
): Promise<number> {
	let removed = 0;
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const listing = await env.BUCKET.list({ prefix, cursor, limit: PAGE });
		const old = listing.objects.filter((object) => now.getTime() - object.uploaded.getTime() > MIN_AGE_MS).map((object) => object.key);
		const orphans: string[] = [];
		for (let index = 0; index < old.length; index += LOOKUP_BATCH) {
			const batch = old.slice(index, index + LOOKUP_BATCH);
			const referenced = await kept(batch);
			orphans.push(...batch.filter((key) => !referenced.has(key)));
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

/**
 * Deletes stored mail objects that no row refers to any more, once they are old enough that any writer has
 * long finished. This catches what the early-return cleanup in `processInboundMessage` cannot (messages
 * dropped after their final failed retry, mail accepted for addresses that never resolved to a mailbox), and
 * it is also the durable cleanup for a retention delete that removed the row but crashed or hit a storage
 * error before removing its objects — `src/lib/email/trash-retention.ts` deliberately deletes the row first.
 * Covered: raw MIME under `inbound/` and `imports/` that no `messages.raw_r2_key` names, and `attachments/`
 * objects that no attachment row or Drive item references. Afterwards it removes stale relay/SNS dedupe
 * objects and old JMAP uploads.
 */
export async function sweepOrphanedRawMail(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	let removed = 0;

	const rawKeys = async (keys: string[]) => {
		const referenced = await db.select({ key: messages.rawR2Key }).from(messages).where(inArray(messages.rawR2Key, keys));
		return new Set(referenced.flatMap((row) => row.key ? [row.key] : []));
	};
	for (const prefix of RAW_PREFIXES) {
		removed += await sweepUnreferenced(env, prefix, now, rawKeys);
	}
	// A Drive item saved from an attachment keeps the object alive, so this reuses the same reference check
	// the delete path uses rather than only looking at message_attachments.
	removed += await sweepUnreferenced(env, ATTACHMENT_PREFIX, now, (keys) => findReferencedKeys(db, keys));

	// After the main sweep, so a backlog under these prefixes cannot use up its request budget.
	for (const { prefix, maxAgeMs } of STALE_PREFIXES) {
		await sweepStaleObjects(env.BUCKET, prefix, maxAgeMs, now).catch((error) => console.error(`Sweep of ${prefix} failed`, error));
	}
	return removed;
}

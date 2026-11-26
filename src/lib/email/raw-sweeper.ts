import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { INBOUND_SIGNATURE_MAX_AGE_SECONDS } from "@/lib/email/intake-signature";
import { SNS_MAX_AGE_MS } from "@/lib/aws/sns-signature";
import { UPLOAD_PREFIX } from "@/lib/jmap/blobs";
import { sweepStaleObjects } from "@/lib/email/stale-objects";
import { REQUEST_UPLOAD_PREFIX } from "@/lib/uploads/constants";

const PREFIX = "inbound/";
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
 * Deletes raw MIME under `inbound/` that no stored message refers to and that is old enough
 * that its queue message is long finished. This catches what the early-return cleanup in
 * `processInboundMessage` cannot: messages dropped after their final failed retry and
 * mail accepted for addresses that never resolved to a mailbox. Afterwards it removes stale relay/SNS dedupe objects and old JMAP uploads.
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
	// After the main sweep, so a backlog under these prefixes cannot use up its request budget.
	for (const { prefix, maxAgeMs } of STALE_PREFIXES) {
		await sweepStaleObjects(env.BUCKET, prefix, maxAgeMs, now).catch((error) => console.error(`Sweep of ${prefix} failed`, error));
	}
	return removed;
}

const PAGE = 1000;
/** Pages per run, so one prefix cannot use a whole run's request budget; the next run continues. */
const MAX_PAGES = 5;

/**
 * Deletes objects under `prefix` last written more than `maxAgeMs` ago. Listing is by key, not age, so a
 * run looks at a bounded number of pages and the next scheduled run picks up the rest.
 */
export async function sweepStaleObjects(bucket: R2Bucket, prefix: string, maxAgeMs: number, now = new Date()): Promise<number> {
	let removed = 0;
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const listing = await bucket.list({ prefix, cursor, limit: PAGE });
		const stale = listing.objects.filter((object) => now.getTime() - object.uploaded.getTime() > maxAgeMs).map((object) => object.key);
		if (stale.length) {
			await bucket.delete(stale);
			removed += stale.length;
		}
		if (!listing.truncated || !listing.cursor) break;
		cursor = listing.cursor;
	}
	return removed;
}

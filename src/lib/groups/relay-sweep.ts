import { dayOf, GROUP_RELAY_PREFIX, GROUP_RELAY_TTL_DAYS } from "@/lib/groups/relay-utils";

const PAGE = 1000;
/** Pages per day prefix and run; what is left is still there on the next run, which looks back far enough to find it. */
const MAX_PAGES = 20;
/** Days older than the TTL that each run still looks at, so a missed run (or a long backlog) is picked up. */
const LOOKBACK_DAYS = 2;

/** Deletes everything under one day's prefix. Each pass lists from the start, because what was listed is gone. */
async function deleteDay(bucket: R2Bucket, day: number): Promise<number> {
	let removed = 0;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const listing = await bucket.list({ prefix: `${GROUP_RELAY_PREFIX}${day}/`, limit: PAGE });
		const keys = listing.objects.map((object) => object.key);
		if (!keys.length) break;
		await bucket.delete(keys);
		removed += keys.length;
		if (!listing.truncated) break;
	}
	return removed;
}

/**
 * Removes the relay copies, Message-ID records, cap and chunk markers of days past their TTL, a whole day at a time.
 * Everything relaying writes is under `group-relay/<day>/`, so the work is the size of one old day, not of everything
 * ever written: a busy week cannot stall the sweep the way an age filter over one listing would.
 */
export async function sweepGroupRelay(bucket: R2Bucket, now: Date = new Date()): Promise<number> {
	let removed = 0;
	const newestExpired = dayOf(now) - GROUP_RELAY_TTL_DAYS;
	for (let day = newestExpired; day >= newestExpired - LOOKBACK_DAYS; day -= 1) removed += await deleteDay(bucket, day);
	return removed;
}

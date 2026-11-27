import { dayOf, GROUP_RELAY_PREFIX, GROUP_RELAY_TTL_DAYS } from "@/lib/groups/relay-utils";

const PAGE = 1000;
/** Pages per day prefix and run; what is left is found again by the next run, which starts from the oldest day that exists. */
const MAX_PAGES = 20;
/** Day prefixes a run may clear; a larger backlog is finished by the following runs. */
const MAX_DAYS = 10;

/** The oldest day that has anything under it, found without a delimiter (not every bucket has one): keys sort by day. */
async function oldestDay(bucket: R2Bucket): Promise<number | null> {
	const first = (await bucket.list({ prefix: GROUP_RELAY_PREFIX, limit: 1 })).objects[0]?.key;
	const match = first ? /^group-relay\/(\d+)\//.exec(first) : null;
	return match ? Number(match[1]) : null;
}

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
 * Everything relaying writes is under `group-relay/<day>/`, so the work is the size of the old days, not of everything
 * ever written: a busy week cannot stall the sweep the way an age filter over one listing would. The oldest day that
 * exists is found by listing one key, so a day missed by any number of runs is still found and cleared.
 */
export async function sweepGroupRelay(bucket: R2Bucket, now: Date = new Date()): Promise<number> {
	let removed = 0;
	const newestExpired = dayOf(now) - GROUP_RELAY_TTL_DAYS;
	for (let days = 0; days < MAX_DAYS; days += 1) {
		const day = await oldestDay(bucket);
		// Nothing left, a key that is not under a day (never deleted here), or a day still within its TTL.
		if (day === null || day > newestExpired) break;
		removed += await deleteDay(bucket, day);
	}
	return removed;
}

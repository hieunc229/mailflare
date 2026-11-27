import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { driveItems, messageAttachments } from "@/db/schema";

const KEY_CHUNK = 90;

/** Rows about to be deleted along with their objects; they do not count as other users of a key. */
export type SharedObjectExclusions = {
	driveItemIds?: string[];
	attachmentIds?: string[];
};

/**
 * Saving an attachment to Drive stores no second copy: the Drive item points at the attachment's
 * object. An object is therefore deleted only when neither a Drive item nor an attachment other
 * than the ones being removed still references it.
 */
export async function findReferencedKeys(
	db: AppDatabase,
	keys: string[],
	exclude: SharedObjectExclusions = {},
): Promise<Set<string>> {
	const referenced = new Set<string>();
	const unique = [...new Set(keys)];
	const excludedItems = new Set(exclude.driveItemIds);
	const excludedAttachments = new Set(exclude.attachmentIds);
	// Excluded ids are dropped in memory: binding them too would pass D1's 100-parameter limit.
	// All lookups go out as one batch (one D1 call), however many keys there are.
	const queries: PromiseLike<unknown>[] = [];
	for (let index = 0; index < unique.length; index += KEY_CHUNK) {
		const chunk = unique.slice(index, index + KEY_CHUNK);
		queries.push(
			db.select({ id: driveItems.id, key: driveItems.r2Key }).from(driveItems).where(inArray(driveItems.r2Key, chunk)),
			db.select({ id: messageAttachments.id, key: messageAttachments.r2Key }).from(messageAttachments).where(inArray(messageAttachments.r2Key, chunk)),
		);
	}
	if (queries.length === 0) return referenced;
	const results = (await db.batch(queries as never)) as { id: string; key: string | null }[][];
	for (const [position, rows] of results.entries()) {
		const excluded = position % 2 === 0 ? excludedItems : excludedAttachments;
		for (const row of rows) if (row.key && !excluded.has(row.id)) referenced.add(row.key);
	}
	return referenced;
}

/** Deletes the objects no remaining row references. Returns the keys it deleted. */
export async function deleteUnreferencedObjects(
	env: CloudflareEnv,
	db: AppDatabase,
	keys: string[],
	exclude: SharedObjectExclusions = {},
): Promise<string[]> {
	const unique = [...new Set(keys)];
	if (unique.length === 0) return [];
	const referenced = await findReferencedKeys(db, unique, exclude);
	const deletable = unique.filter((key) => !referenced.has(key));
	for (let index = 0; index < deletable.length; index += 1000) await env.BUCKET.delete(deletable.slice(index, index + 1000));
	return deletable;
}

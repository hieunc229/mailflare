import { and, inArray, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, messageAttachments } from "@/db/schema";
import { deleteDriveItems } from "./access";
import { deleteUnreferencedObjects } from "@/lib/drive/shared-objects";

export const DRIVE_TRASH_RETENTION_DAYS = 30;
const BATCH_SIZE = 100;
const MAX_PASSES = 20;

/**
 * Permanently deletes Drive items and email attachments that have been in the trash for 30 days or more: database
 * rows and stored objects both. Runs once a day from the scheduled handler. Each pass handles one batch of each kind
 * and passes repeat until nothing is left (up to a cap), so a large backlog is cleared in a single daily run.
 */
export async function runDriveTrashRetention(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	const cutoff = new Date(now.getTime() - DRIVE_TRASH_RETENTION_DAYS * 24 * 60 * 60_000);
	let removed = 0;

	for (let pass = 0; pass < MAX_PASSES; pass += 1) {
		const expiredItems = await db.select().from(driveItems).where(and(isNotNull(driveItems.trashedAt), lte(driveItems.trashedAt, cutoff))).limit(BATCH_SIZE);
		if (expiredItems.length) await deleteDriveItems(env, expiredItems);

		const expiredAttachments = await db
			.select({ id: messageAttachments.id, r2Key: messageAttachments.r2Key })
			.from(messageAttachments)
			.where(and(isNotNull(messageAttachments.trashedAt), lte(messageAttachments.trashedAt, cutoff)))
			.limit(BATCH_SIZE);
		if (expiredAttachments.length) {
			// An attachment saved to Drive shares its object with that Drive item.
			await deleteUnreferencedObjects(env, db, expiredAttachments.map((row) => row.r2Key), { attachmentIds: expiredAttachments.map((row) => row.id) });
			await db.delete(messageAttachments).where(inArray(messageAttachments.id, expiredAttachments.map((row) => row.id)));
		}

		removed += expiredItems.length + expiredAttachments.length;
		if (expiredItems.length < BATCH_SIZE && expiredAttachments.length < BATCH_SIZE) break;
	}
	return removed;
}

import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { deleteMessagesAttachmentObjects } from "@/lib/email/attachments";

/** Remove every external object owned by a message before deleting its row. */
export async function deleteMessageWithObjects(
	env: CloudflareEnv,
	db: AppDatabase,
	id: string,
	rawR2Key: string | null,
): Promise<void> {
	await deleteMessagesWithObjects(env, db, [{ id, rawR2Key }]);
}

/**
 * Batch form of {@link deleteMessageWithObjects}. Objects go first, then the rows, as before:
 * a retry after a failure finds the rows still there and deletes the objects again.
 */
export async function deleteMessagesWithObjects(
	env: CloudflareEnv,
	db: AppDatabase,
	items: { id: string; rawR2Key: string | null }[],
): Promise<void> {
	if (items.length === 0) return;
	const ids = items.map((item) => item.id);
	await deleteMessagesAttachmentObjects(env, ids);
	const rawKeys = [...new Set(items.flatMap((item) => (item.rawR2Key ? [item.rawR2Key] : [])))];
	for (let index = 0; index < rawKeys.length; index += 500) await env.BUCKET.delete(rawKeys.slice(index, index + 500));
	for (let index = 0; index < ids.length; index += 50) {
		await db.delete(messages).where(inArray(messages.id, ids.slice(index, index + 50)));
	}
}

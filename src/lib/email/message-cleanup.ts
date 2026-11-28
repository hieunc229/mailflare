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

/** Remove the external objects (attachments, raw MIME) of the messages; the rows stay. */
export async function deleteMessageObjects(
	env: CloudflareEnv,
	items: { id: string; rawR2Key: string | null }[],
): Promise<void> {
	if (items.length === 0) return;
	await deleteMessagesAttachmentObjects(env, items.map((item) => item.id));
	const rawKeys = [...new Set(items.flatMap((item) => (item.rawR2Key ? [item.rawR2Key] : [])))];
	// R2 deletes up to 1000 keys per call.
	for (let index = 0; index < rawKeys.length; index += 1000) await env.BUCKET.delete(rawKeys.slice(index, index + 1000));
}

/** Row deletes for the ids, unexecuted (50 per statement, D1's 100 bound parameters). */
export function buildMessageDeletes(db: AppDatabase, ids: string[]) {
	const deletes: PromiseLike<unknown>[] = [];
	for (let index = 0; index < ids.length; index += 50) {
		deletes.push(db.delete(messages).where(inArray(messages.id, ids.slice(index, index + 50))));
	}
	return deletes;
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
	await deleteMessageObjects(env, items);
	for (const statement of buildMessageDeletes(db, items.map((item) => item.id))) await statement;
}

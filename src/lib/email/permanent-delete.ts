import type { AppDatabase } from "@/db";
import { buildMessageDeletes, deleteMessageObjects } from "@/lib/email/message-cleanup";
import { buildAuditLogInserts } from "@/lib/mailboxes/audit";

/** Ids per statement: keeps each query under D1's 100 bound parameters. */
const PERMANENT_DELETE_CHUNK = 50;

type DeletableMessage = {
	id: string;
	mailboxId: string | null;
	rawR2Key: string | null;
	status: string;
};

/**
 * Permanently remove messages (row, raw MIME and attachment objects) and audit
 * each one. The audit row cannot point at the deleted message, since its
 * `message_id` is a foreign key, so the id travels in the metadata instead.
 */
export async function permanentlyDeleteMessages(
	env: CloudflareEnv,
	db: AppDatabase,
	actorUserId: string,
	rows: DeletableMessage[],
	source: "bulk" | "empty" | "retention",
): Promise<number> {
	for (let index = 0; index < rows.length; index += PERMANENT_DELETE_CHUNK) {
		const chunk = rows.slice(index, index + PERMANENT_DELETE_CHUNK);
		const items = chunk.map((row) => ({ id: row.id, rawR2Key: row.rawR2Key }));
		// Objects first, then the row delete and its audit rows in one batch (one D1 call).
		await deleteMessageObjects(env, items);
		await db.batch([
			...buildMessageDeletes(db, items.map((item) => item.id)),
			...buildAuditLogInserts(db, chunk.map((row) => ({
				actorUserId,
				mailboxId: row.mailboxId,
				action: "email.delete",
				metadata: { permanent: true, source, messageId: row.id, previousStatus: row.status },
			}))),
		] as never);
	}
	return rows.length;
}

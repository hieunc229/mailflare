import type { AppDatabase } from "@/db";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { deleteUnreferencedObjects } from "@/lib/drive/shared-objects";
import { createAuditLog } from "@/lib/mailboxes/audit";

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
	for (const row of rows) {
		await deleteMessageWithObjects(env, db, row.id, row.rawR2Key);
		await createAuditLog(env, {
			actorUserId,
			mailboxId: row.mailboxId,
			action: "email.delete",
			metadata: { permanent: true, source, messageId: row.id, previousStatus: row.status },
		});
	}
	return rows.length;
}

/**
 * Finish a retention deletion whose row is already gone. Retention deletes the row first, because the
 * conditional `DELETE ... RETURNING` is the claim that decides whether the message is still eligible; the
 * objects therefore have to be cleaned from attachment keys captured before that delete (their rows cascade
 * away with the message). Only ever called after a successful claim, so an object is never removed for a
 * message that survived.
 *
 * The audit row is written before the storage calls: the deletion already happened, so recording it must not
 * depend on storage. A failure here leaves orphaned objects (storage cost) rather than a live message without
 * its mail, and the row is already counted as deleted by the caller. The ordering has one consequence: an
 * audit write that fails aborts the object cleanup and is logged by the caller as such — the sweep in
 * `sweepOrphanedRawMail` reaps those objects later, so the audit (and the row) is never rolled back. This is
 * not an atomic audit-plus-cleanup promise.
 */
export async function cleanupClaimedMessageObjects(
	env: CloudflareEnv,
	db: AppDatabase,
	actorUserId: string,
	row: DeletableMessage,
	attachmentKeys: string[],
): Promise<void> {
	await createAuditLog(env, {
		actorUserId,
		mailboxId: row.mailboxId,
		action: "email.delete",
		metadata: { permanent: true, source: "retention", messageId: row.id, previousStatus: row.status },
	});
	if (attachmentKeys.length > 0) await deleteUnreferencedObjects(env, db, attachmentKeys);
	if (row.rawR2Key) await env.BUCKET.delete(row.rawR2Key);
}

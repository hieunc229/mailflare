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

/** The object deletes for a claimed message. Each one is idempotent, so a retry is always safe. */
async function deleteClaimedObjects(
	env: CloudflareEnv,
	db: AppDatabase,
	rawR2Key: string | null,
	attachmentKeys: string[],
): Promise<void> {
	if (attachmentKeys.length > 0) await deleteUnreferencedObjects(env, db, attachmentKeys);
	if (rawR2Key) await env.BUCKET.delete(rawR2Key);
}

/**
 * Finish a retention deletion whose row is already gone. Retention deletes the row first, because the
 * conditional `DELETE ... RETURNING` is the claim that decides whether the message is still eligible; the
 * objects therefore have to be cleaned from attachment keys captured before that delete (their rows cascade
 * away with the message). Only ever called after a successful claim, so an object is never removed for a
 * message that survived.
 *
 * The audit row is written before the storage calls: the deletion already happened, so recording it must not
 * depend on storage, and the row is already counted as deleted by the caller. An audit write that fails aborts
 * the object cleanup and is logged by the caller as such; the audit (and the row) is never rolled back. This is
 * not an atomic audit-plus-cleanup promise.
 *
 * A storage failure after the audit row is retried once, immediately, for the same keys. The deletes are
 * idempotent and the keys belong to this run's claim, so this needs no state and cannot touch another message.
 * If the retry fails too, the objects stay behind: they are **retained indefinitely**. There is deliberately no
 * cross-run reaper here — reclaiming them safely means serializing reference creation (for example saving an
 * attachment to Drive) against object deletion, which needs writer coordination (a GC claim table honoured by
 * both writers in one transaction), and that is its own design slice rather than a bolt-on to retention. The
 * volume is bounded by the crash/failure window, not by mailbox size.
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
	try {
		await deleteClaimedObjects(env, db, row.rawR2Key, attachmentKeys);
	} catch (error) {
		console.error("Retention could not remove the objects of message", row.id, "retrying once", error);
		await deleteClaimedObjects(env, db, row.rawR2Key, attachmentKeys);
	}
}

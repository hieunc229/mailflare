import { eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { byteLength } from "@/db/sql";

export type MailboxUsage = {
	messageCount: number;
	bodyBytes: number;
	attachmentBytes: number;
	totalBytes: number;
};

/**
 * On-demand per-mailbox storage usage, the same idiom as Drive's `getDriveStorageUsed`:
 * summed off the tables at read time, nothing persisted. Covers the bytes the schema can
 * attribute to a mailbox — stored text/html bodies plus the recorded size of each
 * attachment. Every message status counts: Trash and Spam still occupy storage and
 * retention purges are a separate system. Byte lengths are octet lengths (UTF-8 bytes),
 * see `byteLength` in src/db/sql.ts.
 *
 * Known gap: raw MIME blobs in R2 are not included. `rawR2Key` is
 * `inbound/<sha256(mailboxId \0 raw)>.eml`, so a bucket listing cannot group by mailbox
 * and a per-object HEAD costs O(messages). Recording the raw size next to `rawR2Key` at
 * intake is schema work left to a later quota slice.
 */
export async function getMailboxUsage(db: AppDatabase, mailboxId: string): Promise<MailboxUsage> {
	const [[messageStats], [attachmentStats]] = await Promise.all([
		db
			.select({
				messageCount: sql<number>`count(*)`,
				bodyBytes: sql<number>`coalesce(sum(${byteLength(messages.textBody)}), 0) + coalesce(sum(${byteLength(messages.htmlBody)}), 0)`,
			})
			.from(messages)
			.where(eq(messages.mailboxId, mailboxId)),
		db
			.select({ attachmentBytes: sql<number>`coalesce(sum(${messageAttachments.size}), 0)` })
			.from(messageAttachments)
			.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
			.where(eq(messages.mailboxId, mailboxId)),
	]);
	const bodyBytes = Number(messageStats?.bodyBytes ?? 0);
	const attachmentBytes = Number(attachmentStats?.attachmentBytes ?? 0);
	return {
		messageCount: Number(messageStats?.messageCount ?? 0),
		bodyBytes,
		attachmentBytes,
		totalBytes: bodyBytes + attachmentBytes,
	};
}

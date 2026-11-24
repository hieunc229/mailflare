import { and, eq } from "drizzle-orm";
import type { getDb } from "@/db";
import { mailboxSenderPreferences } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { detectBulkMail, type MailHeaders } from "@/lib/email/bulk-mail";
import { decideCategory, toSenderAddress } from "@/lib/promotions/classify-utils";

type Db = ReturnType<typeof getDb>;

/**
 * Decides the category of one inbound message and the sender key to store with it. Runs in
 * every promotions mode, so the view is ready the moment a mailbox turns it on. Classification
 * must never block delivery: any failure, including a missing table before the migration, means
 * "no override" or "not promotions".
 */
export async function classifyInboundCategory(db: Db, input: {
	mailboxId: string;
	from: string;
	headers: MailHeaders | undefined;
	/** `contacts.source` of the sender, when known. */
	contactSource?: string | null;
}): Promise<{ category: "promotions" | null; senderAddress: string | null }> {
	const senderAddress = toSenderAddress(input.from);
	let override: "inbox" | "promotions" | null = null;
	if (senderAddress) {
		try {
			const [row] = await db.select({ override: mailboxSenderPreferences.categoryOverride }).from(mailboxSenderPreferences).where(and(
				eq(mailboxSenderPreferences.mailboxId, input.mailboxId),
				eq(mailboxSenderPreferences.senderAddress, senderAddress),
			)).limit(1);
			override = row?.override ?? null;
		} catch (error) {
			if (!isMissingTableError(error)) {
				// Unknown failure: the override may say "always Inbox", so leave the mail in Inbox.
				console.error(`Sender override lookup failed for mailbox ${input.mailboxId}`, error);
				return { category: null, senderAddress };
			}
		}
	}
	const category = decideCategory({
		verdict: detectBulkMail(input.headers),
		override,
		correspondent: input.contactSource === "manual" || input.contactSource === "outbound",
	});
	return { category, senderAddress };
}

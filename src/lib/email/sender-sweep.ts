import { and, eq, isNull, ne, or } from "drizzle-orm";
import { messages } from "@/db/schema";
import { escapeLike, insensitiveLike } from "@/db/sql";

/** Past messages from the same sender that a sweep would move to Trash. Starred mail and mail filed by the user stay put. */
export function senderTrashCondition(mailboxId: string, senderAddress: string) {
	return and(
		eq(messages.mailboxId, mailboxId),
		insensitiveLike(messages.fromAddr, `%${escapeLike(senderAddress)}%`),
		eq(messages.starred, false),
		isNull(messages.folderId),
		ne(messages.status, "trash"),
	);
}

/**
 * The Subscriptions "Trash all" condition: an exact sender match on the indexed `sender_address`, with a
 * from-header fallback only for legacy rows that have none. Unlike `senderTrashCondition` it does not
 * substring-match (`news@acme.com` must not sweep `othernews@acme.com`).
 */
export function senderSweepCondition(mailboxId: string, senderAddress: string) {
	return and(
		eq(messages.mailboxId, mailboxId),
		eq(messages.direction, "inbound"),
		or(
			eq(messages.senderAddress, senderAddress),
			and(isNull(messages.senderAddress), insensitiveLike(messages.fromAddr, `%<${escapeLike(senderAddress)}>%`)),
			and(isNull(messages.senderAddress), insensitiveLike(messages.fromAddr, escapeLike(senderAddress))),
		),
		eq(messages.starred, false),
		isNull(messages.folderId),
		ne(messages.status, "trash"),
	);
}

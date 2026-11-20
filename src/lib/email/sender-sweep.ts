import { and, eq, isNull, ne, or } from "drizzle-orm";
import { messages } from "@/db/schema";
import { escapeLike, insensitiveLike } from "@/db/sql";

/**
 * The Subscriptions "Trash all" condition: an exact sender match on the indexed `sender_address`, with a
 * from-header fallback only for legacy rows that have none. It matches the exact address (`news@acme.com` must not sweep `othernews@acme.com`).
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

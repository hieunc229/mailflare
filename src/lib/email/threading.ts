import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { messages } from "@/db/schema";
import { insensitiveLike } from "@/db/sql";
import { newId } from "@/lib/ids";
import type { ResolveThreadInput } from "@/lib/email/threading-types";
import { normalizeMessageId, selectThreadLookupIds } from "@/lib/email/thread-lookup";

export { normalizeMessageId } from "@/lib/email/thread-lookup";

type Db = ReturnType<typeof getDb>;

/** A References header is a whitespace (occasionally comma) separated list of Message-IDs. */
export function parseMessageIdList(value: string | null | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const token of (value ?? "").split(/[\s,]+/)) {
		const id = normalizeMessageId(token);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

export function formatMessageIdHeader(ids: string[]): string {
	return ids.map((id) => `<${id}>`).join(" ");
}

/**
 * The References line a reply should carry: the parent's own chain followed by
 * the parent itself. Long chains keep the root and the most recent ancestors,
 * which is what mail clients use to reconstruct a conversation.
 */
export function buildReplyReferences(parentReferences: string[], parentMessageId: string | null): string[] {
	const ids = [...parentReferences];
	const parent = normalizeMessageId(parentMessageId);
	if (parent && !ids.includes(parent)) ids.push(parent);
	const MAX = 30;
	if (ids.length <= MAX) return ids;
	return [ids[0], ...ids.slice(ids.length - (MAX - 1))];
}

/**
 * Work out which conversation a message belongs to. A reply names its parent in
 * In-Reply-To or References; if that parent is stored in the same mailbox, the
 * new message joins the parent's thread. Otherwise it starts a thread keyed by
 * its own Message-ID so later replies can find it.
 */
export async function resolveThreadId(db: Db, input: ResolveThreadInput): Promise<string> {
	const candidates = selectThreadLookupIds(input.inReplyTo, input.references ?? []);

	if (input.mailboxId && candidates.length > 0) {
		// Stored Message-IDs may or may not include their angle brackets.
		const variants = candidates.flatMap((id) => [id, `<${id}>`]);
		const [parent] = await db
			.select({ threadId: messages.threadId, providerMessageId: messages.providerMessageId })
			.from(messages)
			.where(and(eq(messages.mailboxId, input.mailboxId), inArray(messages.providerMessageId, variants)))
			.orderBy(asc(messages.createdAt))
			.limit(1);
		if (parent) {
			const threadId = parent.threadId ?? normalizeMessageId(parent.providerMessageId) ?? newId("thr");
			// In-Reply-To is attacker-controlled, so an inbound message only joins a conversation
			// that its sender already takes part in.
			if (!input.senderAddress || await isThreadParticipant(db, input.mailboxId, threadId, input.senderAddress)) return threadId;
			return newId("thr");
		}
	}

	const own = normalizeMessageId(input.messageId);
	// A Message-ID that is already some stored thread's id must not pull this message into it.
	if (own && input.mailboxId && input.senderAddress) {
		const [taken] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.threadId, own))).limit(1);
		if (taken) return newId("thr");
	}
	return own ?? newId("thr");
}

async function isThreadParticipant(db: Db, mailboxId: string, threadId: string, address: string): Promise<boolean> {
	// "_" in an address only widens the match to a one-character wildcard; "%" is dropped.
	const pattern = `%${address.trim().toLowerCase().replace(/%/g, "")}%`;
	const [match] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(
			eq(messages.mailboxId, mailboxId),
			eq(messages.threadId, threadId),
			or(
				insensitiveLike(messages.fromAddr, pattern),
				insensitiveLike(messages.toAddr, pattern),
				insensitiveLike(messages.ccAddr, pattern),
				insensitiveLike(messages.replyTo, pattern),
			),
		))
		.limit(1);
	return Boolean(match);
}

import { eq, not, or, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { jmapChanges, messages } from "@/db/schema";

/**
 * Drafts are private to the user who wrote them, even inside a shared mailbox that others can read.
 * Every message query that serves readers of a mailbox must include this predicate.
 *
 * `messages.private_draft` is set when a row is created as a draft and stays set wherever the row is
 * moved afterwards (Trash, Archive, a folder, the inbox), so the rule does not depend on `status`.
 * It is cleared only by a real send or an explicit "sent" from the author, never by a folder move. Sent mail that a teammate files or trashes
 * stays visible to the mailbox's readers.
 */

/** Bound parameters `draftsVisibleTo` adds to a query. D1 allows 100 per statement, so batch sizes subtract it. */
export const DRAFT_FILTER_PARAMS = 1;

export function draftsVisibleTo(userId: string): SQL {
	return or(eq(messages.userId, userId), not(messages.privateDraft))!;
}

/**
 * The same rule for a row that is already loaded. A row selected without `privateDraft` counts as
 * private, so a forgotten column hides a message instead of leaking it.
 */
export function isOthersDraft(message: { privateDraft: boolean | null; userId: string | null }, userId: string): boolean {
	return message.privateDraft !== false && message.userId !== userId;
}

/** Column change for a status change: a row becoming a draft turns private, a row becoming sent mail is released. */
export function privateDraftForStatus(status: string): { privateDraft?: boolean } {
	if (status === "draft") return { privateDraft: true };
	if (status === "sent") return { privateDraft: false };
	return {};
}

/**
 * A visible message that turned into a draft is gone for everyone but its author. The change feeds
 * drop every change on a message a reader cannot see, so this "hidden" entry is what tells readers
 * of the mailbox it was destroyed (its author just sees an update).
 */
export async function logMessageHidden(
	db: AppDatabase,
	message: { id: string; mailboxId: string | null; threadId: string | null },
): Promise<void> {
	if (!message.mailboxId) return;
	await db.insert(jmapChanges).values({ mailboxId: message.mailboxId, objectType: "email", objectId: message.id, threadId: message.threadId ?? message.id, change: "hidden" });
}

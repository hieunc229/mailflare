import { eq, ne, or, type SQL } from "drizzle-orm";
import { messages } from "@/db/schema";

/**
 * Drafts are private to the user who wrote them, even inside a shared mailbox that others can read.
 * Every message query that serves readers of a mailbox must include this predicate.
 */
/** Bound parameters `draftsVisibleTo` adds to a query. D1 allows 100 per statement, so batch sizes subtract it. */
export const DRAFT_FILTER_PARAMS = 2;

export function draftsVisibleTo(userId: string): SQL {
	return or(ne(messages.status, "draft"), eq(messages.userId, userId))!;
}

/** The same rule for a row that is already loaded. */
export function isOthersDraft(message: { status: string | null; userId: string | null }, userId: string): boolean {
	return message.status === "draft" && message.userId !== userId;
}

import { chunk } from "@/lib/promotions/refile-utils";
import { toSenderAddress } from "@/lib/promotions/classify-utils";

export { chunk };

/** Subscriptions only looks at the last 90 days, one page of senders at a time. */
export const SUBSCRIPTION_WINDOW_DAYS = 90;
export const SUBSCRIPTIONS_PAGE_SIZE = 50;
/**
 * "Trash all" reaches at most this many rows of the last SWEEP_WINDOW_DAYS days per request: every row written fires the
 * change-log and trashed_at triggers, and D1 meters row writes.
 */
export const SWEEP_WINDOW_DAYS = 90;
export const MAX_SWEEP_ROWS = 500;
/** An UPDATE binds the new status, the mailbox, the sender guard (up to 5) and one id per row; D1 allows 100. */
export const SWEEP_CHUNK_SIZE = 80;
/** A sender that mails again later than this after an unsubscribe is "still sending". */
export const STILL_SENDING_GRACE_MS = 2 * 86_400_000;

export const windowStart = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

export function parseTrashBody(body: unknown): { mailboxId: string; senderAddress: string; previewOnly: boolean } | { error: string } {
	const value = body && typeof body === "object" ? (body as { mailboxId?: unknown; senderAddress?: unknown; previewOnly?: unknown }) : null;
	if (!value || typeof value.mailboxId !== "string" || !value.mailboxId) return { error: "mailboxId is required" };
	const senderAddress = typeof value.senderAddress === "string" ? toSenderAddress(value.senderAddress) : null;
	if (!senderAddress) return { error: "senderAddress must be a valid address of at most 191 characters" };
	if (value.previewOnly !== undefined && typeof value.previewOnly !== "boolean") return { error: "previewOnly must be a boolean" };
	return { mailboxId: value.mailboxId, senderAddress, previewOnly: value.previewOnly === true };
}

export const isStillSending = (lastReceived: Date, unsubscribedAt: Date | null) =>
	unsubscribedAt !== null && lastReceived.getTime() > unsubscribedAt.getTime() + STILL_SENDING_GRACE_MS;

/*
 * Subscriptions "Block" uses the existing POST /api/contacts/block. blockContact (src/lib/contacts/service.ts) files a
 * routing rule with action "trash": blocked mail goes to Trash, it is never rejected at SMTP time. Wording says Trash.
 */

import { normalizeEmailAddress } from "@/lib/email/address";
import type { BulkMailVerdict } from "@/lib/email/bulk-mail";

/** `mailboxes`-scoped sender key. MySQL indexes the column as varchar(191), so a longer address is `null`, never truncated. */
const MAX_SENDER_ADDRESS = 191;

/** Lower-cased bare address of a From header value, or null when empty or too long to index. */
export function toSenderAddress(from: string): string | null {
	const address = normalizeEmailAddress(from);
	return address && address.length <= MAX_SENDER_ADDRESS ? address : null;
}

/**
 * The user's per-sender override beats headers; discussion lists and plain mail are never
 * promotions; people the user wrote to (manual or outbound contacts) belong in Inbox.
 */
export function decideCategory(input: { verdict: BulkMailVerdict; override?: "inbox" | "promotions" | null; correspondent?: boolean }): "promotions" | null {
	if (input.override) return input.override === "promotions" ? "promotions" : null;
	return input.verdict.kind === "marketing" && !input.correspondent ? "promotions" : null;
}

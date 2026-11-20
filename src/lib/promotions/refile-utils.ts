import { toSenderAddress } from "@/lib/promotions/classify-utils";

/** Bounded re-files only reach this far back and this many rows per request: every row written fires the change-log and trashed_at triggers, and D1 meters row writes. */
export const REFILE_WINDOW_DAYS = 90;
export const MAX_REFILE_ROWS = 500;
/** D1 allows 100 bound parameters per statement. An update binds the new value, the mailbox, the category guard and one id per row. */
export const REFILE_CHUNK_SIZE = 90;

export type RefileTarget = "promotions" | "primary";

export function refileCutoff(now: Date): Date {
	return new Date(now.getTime() - REFILE_WINDOW_DAYS * 86_400_000);
}

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** The stored marker for a destination: Inbox is the explicit `primary`, never a null the backfill could reclassify. */
export const targetOf = (category: "promotions" | "inbox"): RefileTarget => (category === "inbox" ? "primary" : "promotions");

export function parseCategoryMoveBody(body: unknown): { category: "promotions" | "inbox"; applyToSender: boolean } | { error: string } {
	const value = body && typeof body === "object" ? (body as { category?: unknown; applyToSender?: unknown }) : null;
	if (!value || (value.category !== "promotions" && value.category !== "inbox")) return { error: "category must be promotions or inbox" };
	if (value.applyToSender !== undefined && typeof value.applyToSender !== "boolean") return { error: "applyToSender must be a boolean" };
	return { category: value.category, applyToSender: value.applyToSender === true };
}

export function parsePreferenceBody(body: unknown): { mailboxId: string; senderAddress: string; category: "promotions" | "inbox" | null } | { error: string } {
	const value = body && typeof body === "object" ? (body as { mailboxId?: unknown; senderAddress?: unknown; category?: unknown }) : null;
	if (!value || typeof value.mailboxId !== "string" || !value.mailboxId) return { error: "mailboxId is required" };
	const senderAddress = typeof value.senderAddress === "string" ? toSenderAddress(value.senderAddress) : null;
	if (!senderAddress) return { error: "senderAddress must be a valid address of at most 191 characters" };
	if (value.category !== null && value.category !== "promotions" && value.category !== "inbox") return { error: "category must be inbox, promotions or null" };
	return { mailboxId: value.mailboxId, senderAddress, category: value.category };
}

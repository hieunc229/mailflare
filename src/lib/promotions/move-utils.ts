import type { PluralKey, TranslationKey } from "@/lib/i18n/types";

export type MoveTarget = "promotions" | "inbox";
export type MoveSummary = { total: number; moved: number; failed: number; changed: number };
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
export type CopyDescriptor = { key: TranslationKey | PluralKey; vars?: Record<string, string | number> };

/** Rows move between Inbox and Promotions only where Promotions is on, for people who may manage the mailbox, and only for received mail. Off mailboxes see nothing. */
export function canMoveCategory(input: { mode: string | undefined; permission: string | undefined; direction: string; status: string }): boolean {
	return (input.mode === "show" || input.mode === "separate")
		&& input.permission === "full_access"
		&& input.direction === "inbound"
		&& input.status === "received";
}

/** The list a reader page was opened from, by its path: only Inbox and Promotions offer a move, as their list rows do. */
export function readerFolderOf(pathname: string): "inbox" | "promotions" | "other" {
	const first = pathname.split("/")[1];
	return first === "inbox" || first === "promotions" ? first : "other";
}

/** A promotion goes back to Inbox; anything else (unclassified or already `primary`) goes to Promotions. */
export function moveTargetFor(category: string | null | undefined): MoveTarget {
	return category === "promotions" ? "inbox" : "promotions";
}

/** Inbox rows carry the chip only in `show` mode: in `separate` they are hidden from Inbox, and off shows nothing new. */
export function showsPromotionChip(input: { folder: string; folderId?: string; mode: string | undefined; category: string | null | undefined }): boolean {
	return input.folder === "inbox" && !input.folderId && input.mode === "show" && input.category === "promotions";
}

/** Whether the folder on screen stops listing a message once it moves to `target`. */
export function moveLeavesFolder(folder: string, target: MoveTarget, mode: string | undefined): boolean {
	if (folder === "promotions") return target === "inbox";
	if (folder === "inbox") return target === "promotions" && mode === "separate";
	return false;
}

/** Runs `worker` over `items` with at most `limit` in flight; results keep the input order and a failure never stops the rest. */
export async function runLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<Settled<R>[]> {
	const results: Settled<R>[] = new Array(items.length);
	let next = 0;
	async function lane() {
		while (next < items.length) {
			const index = next++;
			try {
				results[index] = { ok: true, value: await worker(items[index]) };
			} catch (error) {
				results[index] = { ok: false, error };
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	return results;
}

/** `moved` counts messages whose request succeeded, `changed` the rows that actually switched category (the rest were already there). */
export function summarizeMoves(results: Settled<{ changed: number; remainingOlder: number }>[]): MoveSummary {
	let moved = 0;
	let changed = 0;
	for (const result of results) {
		if (!result.ok) continue;
		moved += 1;
		changed += result.value.changed;
	}
	return { total: results.length, moved, failed: results.length - moved, changed };
}

export function moveToastCopy(target: MoveTarget, summary: MoveSummary): CopyDescriptor {
	if (summary.moved === 0) return { key: "promotions.move.failed" };
	if (summary.failed > 0) return { key: "promotions.move.partial", vars: { moved: summary.moved, total: summary.total } };
	if (summary.total === 1) return { key: target === "inbox" ? "promotions.move.doneInbox" : "promotions.move.donePromotions" };
	return { key: target === "inbox" ? "promotions.move.doneManyInbox" : "promotions.move.doneManyPromotions", vars: { count: summary.total } };
}

/** "Always for <sender>" only follows a clean move of a message that has a sender address on record. */
export function canOfferAlways(summary: MoveSummary, senderAddress: string | null | undefined): boolean {
	return !!senderAddress && summary.failed === 0 && summary.moved > 0;
}

/** The sender rule re-files a bounded slice (90 days, 500 rows); older mail is left, and the copy says so. */
export function senderResultCopy(result: { changed: number; remainingOlder: number }): CopyDescriptor {
	if (result.remainingOlder > 0) return { key: "promotions.always.resultOlder", vars: { changed: result.changed, remaining: result.remainingOlder } };
	if (result.changed > 0) return { key: "promotions.always.result", vars: { changed: result.changed } };
	return { key: "promotions.always.nothing" };
}

/** WCAG 2.2.1: hovering or focusing the toast stops its countdown. */
export function isToastPaused(holds: { hover: boolean; focus: boolean }): boolean {
	return holds.hover || holds.focus;
}

export function remainingAfter(remaining: number, startedAt: number, now: number): number {
	return Math.max(0, remaining - Math.max(0, now - startedAt));
}

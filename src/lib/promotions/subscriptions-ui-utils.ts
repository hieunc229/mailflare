import type { CopyDescriptor } from "@/lib/promotions/move-utils";
import { senderResultCopy } from "@/lib/promotions/move-utils";
import { canManagePromotions } from "@/lib/promotions/ui-utils";
import type { SubscriptionCategory, SubscriptionRowData, SubscriptionRowView, SubscriptionTrashAction, TrashPreview } from "./subscriptions-ui-types";

export { SUBSCRIPTIONS_PAGE_SIZE } from "@/lib/promotions/subscriptions-utils";

/** A whole percent between 0 and 100; anything unreadable shows as 0%. */
export function formatReadRate(rate: number): string {
	if (!Number.isFinite(rate)) return "0%";
	return `${Math.min(100, Math.max(0, Math.round(rate)))}%`;
}

/**
 * What one row shows and offers. Only people with full access get the category control and the actions, matching the
 * server. Unsubscribing needs an unsubscribe route on the newest message and is not offered again once done, unless the
 * sender kept mailing ("still sending").
 */
export function getRowView(row: SubscriptionRowData, permission: string | undefined): SubscriptionRowView {
	const canChange = canManagePromotions(permission);
	const stillSending = row.unsubscribedAt !== null && row.stillSending;
	const canUnsubscribe = row.canUnsubscribe && !!row.latestMessageId && (row.unsubscribedAt === null || stillSending);
	return {
		canChange,
		category: row.categoryOverride ?? "auto",
		stillSending,
		unsubscribedOn: row.unsubscribedAt,
		actions: !canChange ? [] : canUnsubscribe ? ["unsubscribe", "unsubscribeTrash", "block", "trash"] : ["block", "trash"],
	};
}

export const categoryToApi = (category: SubscriptionCategory): "inbox" | "promotions" | null => (category === "auto" ? null : category);

/** After a category change: "Automatic" only clears the rule, the others report what was moved and what older mail was left. */
export function categoryResultCopy(category: SubscriptionCategory, result: { changed: number; remainingOlder: number }): CopyDescriptor {
	if (category === "auto") return { key: "subscriptions.categoryCleared" };
	return senderResultCopy(result);
}

/**
 * Confirm text for "move to Trash" actions, or null when there is nothing to move. `willChange` is what this request
 * reaches (last 90 days, at most 500); everything else from the sender stays, and the text says how much.
 */
export function trashConfirmCopy(action: SubscriptionTrashAction, preview: TrashPreview): CopyDescriptor[] | null {
	if (preview.willChange <= 0) return null;
	const stays = preview.count - preview.willChange + preview.olderLeft;
	return [
		{ key: action === "trash" ? "subscriptions.trashConfirm" : "subscriptions.unsubscribeTrashConfirm", vars: { count: preview.willChange } },
		...(stays > 0 ? [{ key: "subscriptions.leftBehind" as const, vars: { count: stays } }] : []),
	];
}

/** What a real run did: the rows it changed and what of the sender is still where it was. Never "all". */
export function trashResultCopy(result: { changed: number; remaining: number }): CopyDescriptor[] {
	return [
		result.changed > 0 ? { key: "subscriptions.trashDone", vars: { count: result.changed } } : { key: "subscriptions.trashNothing" },
		...(result.remaining > 0 ? [{ key: "subscriptions.trashRemaining" as const, vars: { remaining: result.remaining } }] : []),
	];
}

/** Where to load after a refetch: an emptied page (its last sender was trashed, blocked or moved) steps back one page. */
export function pageBackOffset(input: { offset: number; pageSize: number; returned: number; total: number }): number {
	if (input.returned > 0 || input.offset <= 0) return input.offset;
	const lastPage = input.total > 0 ? Math.floor((input.total - 1) / input.pageSize) * input.pageSize : 0;
	return Math.max(0, Math.min(input.offset - input.pageSize, lastPage));
}

export function getPager(input: { offset: number; count: number; total: number; pageSize: number }) {
	if (input.total === 0 || input.count === 0) return { start: 0, end: 0, total: input.total, prevOffset: null, nextOffset: null };
	const end = input.offset + input.count;
	return {
		start: input.offset + 1,
		end,
		total: input.total,
		prevOffset: input.offset > 0 ? Math.max(0, input.offset - input.pageSize) : null,
		nextOffset: end < input.total ? input.offset + input.pageSize : null,
	};
}

/** Mailboxes the page can list: Promotions has to be on for them. */
export function mailboxesWithPromotions<T extends { id: string }>(mailboxes: T[], modes: Record<string, string> | undefined): T[] {
	return mailboxes.filter((mailbox) => !!modes?.[mailbox.id] && modes[mailbox.id] !== "off");
}

/** Keeps the current choice, then the mailbox selected in the header, then the first one. */
export function pickMailboxId(ids: string[], current: string | null, selected: string | null | undefined): string | null {
	if (current && ids.includes(current)) return current;
	if (selected && ids.includes(selected)) return selected;
	return ids[0] ?? null;
}

/** Whole days between a timestamp and now; never negative. */
export function daysSince(value: string, now: Date): number {
	return Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 86_400_000));
}

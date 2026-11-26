import type { MessageCounts, MessageCountsDelta } from "./types";

/** Applies a one-shot unread delta to the folders it names. Returns the same object when nothing changes. */
export function applyCountsDelta(counts: MessageCounts, delta: MessageCountsDelta): MessageCounts {
	const inbox = delta.inboxUnreadDelta ?? 0;
	const promotions = delta.promotionsUnreadDelta ?? 0;
	if (!inbox && !promotions) return counts;
	const folders = { ...counts.folders };
	if (inbox) folders.inbox = { ...folders.inbox, unread: Math.max(0, folders.inbox.unread + inbox) };
	if (promotions) folders.promotions = { ...folders.promotions, unread: Math.max(0, folders.promotions.unread + promotions) };
	return { ...counts, folders };
}

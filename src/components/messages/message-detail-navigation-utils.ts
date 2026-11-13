import type { MessageNavigationEntry } from "@/app/api/messages/navigation/types";
import type { MessageDetailNavigationState } from "./message-detail-navigation-types";

const openedUnreadKey = "mailflare-navigation-opened-unread";

export function rememberOpenedUnreadMessage(messageId: string) {
	try {
		sessionStorage.setItem(openedUnreadKey, messageId);
	} catch {
		// Navigation remains available when browser storage is disabled.
	}
}

export function takeOpenedUnreadMessage(): string | null {
	try {
		const messageId = sessionStorage.getItem(openedUnreadKey);
		sessionStorage.removeItem(openedUnreadKey);
		return messageId;
	} catch {
		return null;
	}
}

/**
 * The message auto-advance opens once `currentId` leaves the list: the one below it in the list
 * (older), else the one above. List order, not the arrows' unread-first order, so it lands on the
 * neighbour you see.
 */
export function getAutoAdvanceId(entries: MessageNavigationEntry[], currentId: string): string | null {
	const index = entries.findIndex((entry) => entry.id === currentId);
	if (index < 0) return null;
	return entries[index + 1]?.id ?? entries[index - 1]?.id ?? null;
}

export function getMessageDetailNavigationState(entries: MessageNavigationEntry[], currentId: string): MessageDetailNavigationState {
	const unread = entries.filter((entry) => entry.unread);
	const ordered = [...unread, ...entries.filter((entry) => !entry.unread)];
	const index = ordered.findIndex((entry) => entry.id === currentId);
	return {
		previousId: index > 0 ? ordered[index - 1].id : null,
		nextId: index >= 0 ? ordered[index + 1]?.id ?? null : null,
		unreadOrder: index >= 0 && index < unread.length ? index + 1 : 0,
		totalUnread: unread.length,
	};
}

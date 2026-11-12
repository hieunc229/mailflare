import { useCallback, useState } from "react";

// Dismissed message ids live in one capped list, not a key per message, so
// storage stays bounded even as messages are dismissed and deleted over time.
const STORAGE_KEY = "mailflare-mailing-list-banner";
const MAX_DISMISSED = 500;

function readDismissedIds(): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

/** Whether the mailing-list banner on `messageId` was dismissed; `dismiss` persists that. */
export function useMailingListBanner(messageId: string): [boolean, () => void] {
	// Lazy init + render-phase re-read on messageId change: a dismissed banner
	// never paints, so there is no visible swap to the inline button.
	const [entry, setEntry] = useState(() => ({ id: messageId, dismissed: readDismissedIds().includes(messageId) }));
	if (entry.id !== messageId) {
		setEntry({ id: messageId, dismissed: readDismissedIds().includes(messageId) });
	}

	const dismiss = useCallback(() => {
		try {
			const ids = readDismissedIds().filter((id) => id !== messageId);
			ids.push(messageId);
			localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_DISMISSED)));
		} catch {
			// Private mode or blocked storage: the banner still hides for this view.
		}
		setEntry({ id: messageId, dismissed: true });
	}, [messageId]);

	return [entry.dismissed, dismiss];
}

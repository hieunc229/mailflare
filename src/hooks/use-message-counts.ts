import { useEffect, useState } from "react";
import type { MessageCounts, MessageCountsDelta } from "./types";
import { hasPendingOverlay, subscribePendingOverlay } from "@/lib/messages/field-store";
import { registerMessageRefresh } from "./message-refresh";
import { hasMembershipOverlay, subscribeMembership } from "@/lib/messages/membership-store";
import { clearMessageCountsCache, fetchMessageCounts } from "./utils";

const REFRESH_DEBOUNCE_MS = 150;

const emptyCounts: MessageCounts = {
	folders: {
		inbox: { total: 0, unread: 0 },
		starred: { total: 0, unread: 0 },
		snoozed: { total: 0, unread: 0 },
		sent: { total: 0, unread: 0 },
		scheduled: { total: 0, unread: 0 },
		drafts: { total: 0, unread: 0 },
		archived: { total: 0, unread: 0 },
		spam: { total: 0, unread: 0 },
		trash: { total: 0, unread: 0 },
	},
	customFolders: {},
	mailboxes: [],
};

export function useMessageCounts(mailboxId?: string | null, enabled = true) {
	const [counts, setCounts] = useState<MessageCounts>(emptyCounts);
	const [isLoading, setIsLoading] = useState(enabled);
	if (!enabled && isLoading) setIsLoading(false);

	useEffect(() => {
		if (!enabled) return;

		let cancelled = false;
		let refreshTimer: number | null = null;
		let requestNumber = 0;
		const hasPending = () => hasPendingOverlay() || hasMembershipOverlay();

		async function loadCounts(force = false, showLoading = true) {
			const currentRequest = ++requestNumber;
			if (showLoading) setIsLoading(true);
			try {
				const nextCounts = await fetchMessageCounts(mailboxId, force);
				if (!cancelled && currentRequest === requestNumber && !hasPending()) {
					setCounts(nextCounts ?? emptyCounts);
				}
			} finally {
				if (!cancelled && currentRequest === requestNumber) setIsLoading(false);
			}
		}

		function scheduleCountsLoad() {
			if (document.visibilityState !== "visible") return;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				// The cache was cleared above, so hooks refreshing for the same change share one request.
				void loadCounts().catch(() => undefined);
			}, REFRESH_DEBOUNCE_MS);
		}

		// A pending undo has not settled on the server yet. Keep the optimistic
		// one-shot delta on screen and fetch authoritative counts only afterwards.
		if (hasPending()) {
			clearMessageCountsCache();
		} else {
			void loadCounts().catch(() => undefined);
		}
		const unregisterRefresh = registerMessageRefresh(() => loadCounts(false, false));
		function onMessagesChanged() {
			if (hasPending()) return;
			clearMessageCountsCache();
			scheduleCountsLoad();
		}
		function onMessageCountsDelta(event: Event) {
			const detail = (event as CustomEvent<MessageCountsDelta>).detail;
			if (!detail?.inboxUnreadDelta) return;
			setCounts((current) => ({
				...current,
				folders: {
					...current.folders,
					inbox: {
						...current.folders.inbox,
						unread: Math.max(0, current.folders.inbox.unread + (detail.inboxUnreadDelta ?? 0)),
					},
				},
			}));
		}
		function onPendingChange() {
			// Invalidate a load that started before the overlay changed so its
			// server value cannot land on top of the optimistic state.
			requestNumber += 1;
			clearMessageCountsCache();
			if (hasPending()) {
				if (refreshTimer) window.clearTimeout(refreshTimer);
				refreshTimer = null;
				setIsLoading(false);
				return;
			}
			scheduleCountsLoad();
		}
		const unsubscribePending = subscribePendingOverlay(onPendingChange);
		const unsubscribeMembership = subscribeMembership(onPendingChange);
		window.addEventListener("mailflare:messages-changed", onMessagesChanged);
		window.addEventListener("mailflare:message-counts-changed", onMessagesChanged);
		window.addEventListener("mailflare:message-counts-delta", onMessageCountsDelta);

		return () => {
			cancelled = true;
			unregisterRefresh();
			window.removeEventListener("mailflare:messages-changed", onMessagesChanged);
			window.removeEventListener("mailflare:message-counts-changed", onMessagesChanged);
			window.removeEventListener("mailflare:message-counts-delta", onMessageCountsDelta);
			unsubscribePending();
			unsubscribeMembership();
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [enabled, mailboxId]);

	return { counts, isLoading };
}

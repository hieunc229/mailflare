import { useEffect, useState } from "react";
import type { ThreadMessage } from "@/hooks/types";
import {
	fetchMessageThread,
	getCachedMessageThread,
	isMessageThreadInvalidated,
	markMessageThreadReadInCaches,
} from "./message-thread-cache";
import type { UseMessageThreadResult } from "./conversation-thread-types";

/** Loads every message in the conversation of `messageId`; refetches when mail changes. */
export function useMessageThread(messageId: string, threadId: string | null | undefined): UseMessageThreadResult {
	const [messages, setMessages] = useState<ThreadMessage[]>(
		() => (threadId ? getCachedMessageThread(messageId) ?? [] : []),
	);
	const [loading, setLoading] = useState(
		() => !!threadId && !getCachedMessageThread(messageId),
	);

	useEffect(() => {
		if (!threadId) return;
		let cancelled = false;
		let refreshTimer: number | null = null;
		async function load() {
			const cached = getCachedMessageThread(messageId);
			if (cached) {
				if (!cancelled) {
					setMessages(cached);
					setLoading(false);
				}
				return;
			}
			setLoading(true);
			try {
				const next = await fetchMessageThread(messageId);
				if (!cancelled) setMessages(next);
			} catch (error) {
				// A newer load is queued; keep the conversation on screen.
				if (!cancelled && !isMessageThreadInvalidated(error)) setMessages([]);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void load();
		function patchReadState(event: Event) {
			const detail = (event as CustomEvent<{ kind?: string; messageIds?: string[]; read?: boolean }>).detail;
			if (detail?.kind !== "read" || !detail.messageIds?.length) return;
			const ids = new Set(detail.messageIds);
			const read = detail.read !== false;
			markMessageThreadReadInCaches(detail.messageIds, read);
			setMessages((current) => current.map((message) => (ids.has(message.id) ? { ...message, read } : message)));
		}
		function scheduleLoad(event?: Event) {
			if ((event as CustomEvent<{ kind?: string }> | undefined)?.detail?.kind === "read") return;
			if (document.visibilityState !== "visible") return;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				void load();
			}, 150);
		}
		window.addEventListener("mailflare:messages-changed", scheduleLoad);
		window.addEventListener("mailflare:messages-changed", patchReadState);
		return () => {
			cancelled = true;
			window.removeEventListener("mailflare:messages-changed", scheduleLoad);
			window.removeEventListener("mailflare:messages-changed", patchReadState);
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [messageId, threadId]);

	return { messages: threadId ? messages : [], loading };
}

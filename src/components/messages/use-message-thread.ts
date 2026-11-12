import { useEffect, useState } from "react";
import type { ThreadMessage } from "@/hooks/types";
import { applyPendingToMessages, subscribePendingOverlay } from "@/lib/messages/field-store";
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
		let loadVersion = 0;
		async function load() {
			const version = ++loadVersion;
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
				if (!cancelled && version === loadVersion) setMessages(applyPendingToMessages(next));
			} catch (error) {
				// A newer load is queued; keep the conversation on screen.
				if (!cancelled && version === loadVersion && !isMessageThreadInvalidated(error)) setMessages([]);
			} finally {
				if (!cancelled && version === loadVersion) setLoading(false);
			}
		}
		void load();
		function patchReadState(event: Event) {
			const detail = (event as CustomEvent<{ kind?: string; messageIds?: string[]; read?: boolean }>).detail;
			if (detail?.kind !== "read" || !detail.messageIds?.length) return;
			// A response started before the read flip must not overwrite it.
			loadVersion += 1;
			const ids = new Set(detail.messageIds);
			const read = detail.read !== false;
			markMessageThreadReadInCaches(detail.messageIds, read);
			setMessages((current) => applyPendingToMessages(current.map((message) => (ids.has(message.id) ? { ...message, read } : message))));
		}
		function patchFieldState(event: Event) {
			const detail = (event as CustomEvent<{ kind?: string; patches?: Array<{ id: string; read?: boolean; starred?: boolean }> }>).detail;
			if (detail?.kind !== "patch" || !detail.patches?.length) return;
			const patches = new Map(detail.patches.map((patch) => [patch.id, patch]));
			setMessages((current) => applyPendingToMessages(current.map((message) => {
				const patch = patches.get(message.id);
				if (!patch) return message;
				return {
					...message,
					...(patch.read !== undefined ? { read: patch.read } : {}),
					...(patch.starred !== undefined ? { starred: patch.starred } : {}),
				};
			})));
		}
		function scheduleLoad() {
			if (document.visibilityState !== "visible") return;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				void load();
			}, 150);
		}
		const unsubscribePending = subscribePendingOverlay(() => {
			setMessages((current) => applyPendingToMessages(current));
		});
		window.addEventListener("mailflare:messages-changed", scheduleLoad);
		window.addEventListener("mailflare:messages-changed", patchReadState);
		window.addEventListener("mailflare:messages-changed", patchFieldState);
		return () => {
			cancelled = true;
			window.removeEventListener("mailflare:messages-changed", scheduleLoad);
			window.removeEventListener("mailflare:messages-changed", patchReadState);
			window.removeEventListener("mailflare:messages-changed", patchFieldState);
			unsubscribePending();
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [messageId, threadId]);

	return { messages: threadId ? messages : [], loading };
}

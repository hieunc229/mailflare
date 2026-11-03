import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { ThreadMessage, ThreadResponse } from "@/hooks/types";
import type { UseMessageThreadResult } from "./conversation-thread-types";

/** Loads every message in the conversation of `messageId`; refetches when mail changes. */
export function useMessageThread(messageId: string, threadId: string | null | undefined): UseMessageThreadResult {
	const [messages, setMessages] = useState<ThreadMessage[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!threadId) return;
		let cancelled = false;
		let refreshTimer: number | null = null;
		async function load() {
			setLoading(true);
			try {
				const response = await authFetch(`/api/messages/${messageId}/thread`);
				const data = (await response.json()) as ThreadResponse;
				if (!cancelled) setMessages(response.ok ? data.messages ?? [] : []);
			} catch {
				if (!cancelled) setMessages([]);
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
			setMessages((current) => current.map((message) => (ids.has(message.id) ? { ...message, read } : message)));
		}
		function scheduleLoad(event?: Event) {
			// A read flip does not change the conversation's bodies.
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

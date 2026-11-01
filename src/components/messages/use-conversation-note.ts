import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { ConversationNote } from "@/lib/notes/types";
import type { UseConversationNoteResult } from "./conversation-note-types";

/** The note pinned to the conversation containing `messageId`; refetches when mail changes. */
export function useConversationNote(messageId: string): UseConversationNoteResult {
	const [note, setNote] = useState<ConversationNote | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		let refreshTimer: number | null = null;
		async function load() {
			setLoading(true);
			try {
				const response = await authFetch(`/api/messages/${messageId}/note`);
				const data = (await response.json().catch(() => null)) as { note?: ConversationNote | null } | null;
				if (!cancelled) setNote(response.ok ? (data?.note ?? null) : null);
			} catch {
				if (!cancelled) setNote(null);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void load();
		function scheduleLoad() {
			if (document.visibilityState !== "visible") return;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				void load();
			}, 150);
		}
		window.addEventListener("mailflare:messages-changed", scheduleLoad);
		return () => {
			cancelled = true;
			window.removeEventListener("mailflare:messages-changed", scheduleLoad);
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [messageId]);

	async function save(html: string) {
		const trimmed = html.trim();
		const response = trimmed
			? await authFetch(`/api/messages/${messageId}/note`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: trimmed }),
			})
			: await authFetch(`/api/messages/${messageId}/note`, { method: "DELETE" });
		if (!response.ok) throw new Error("Note save failed");
		const data = (await response.json().catch(() => null)) as { note?: ConversationNote | null } | null;
		setNote(trimmed ? (data?.note ?? null) : null);
	}

	return { note, loading, save };
}

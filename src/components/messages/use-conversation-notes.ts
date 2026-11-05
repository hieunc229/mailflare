import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { ConversationNote } from "@/lib/notes/types";
import type { UseConversationNotesResult } from "./conversation-notes-types";

/** The notes on the conversation containing `messageId`; refetches when mail changes. */
export function useConversationNotes(messageId: string): UseConversationNotesResult {
	const [notes, setNotes] = useState<ConversationNote[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		let refreshTimer: number | null = null;
		async function load() {
			try {
				const response = await authFetch(`/api/messages/${messageId}/notes`, { cache: "no-store" });
				const data = (await response.json().catch(() => null)) as { notes?: ConversationNote[] } | null;
				if (!cancelled) setNotes(response.ok ? (data?.notes ?? []) : []);
			} catch {
				if (!cancelled) setNotes([]);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		setLoading(true);
		setNotes([]);
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

	async function add(body: string, attachedMessageId?: string | null) {
		const response = await authFetch(`/api/messages/${messageId}/notes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body, messageId: attachedMessageId ?? undefined }),
		});
		if (!response.ok) throw new Error("Note could not be added");
		const data = (await response.json().catch(() => null)) as { note?: ConversationNote } | null;
		const note = data?.note;
		if (note) setNotes((current) => (current.some((item) => item.id === note.id) ? current : [...current, note]));
	}

	async function update(noteId: string, body: string) {
		const response = await authFetch(`/api/messages/${messageId}/notes/${noteId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body }),
		});
		if (!response.ok) throw new Error("Note could not be saved");
		const data = (await response.json().catch(() => null)) as { note?: ConversationNote } | null;
		const note = data?.note;
		if (note) setNotes((current) => current.map((item) => (item.id === note.id ? note : item)));
	}

	async function remove(noteId: string) {
		const response = await authFetch(`/api/messages/${messageId}/notes/${noteId}`, { method: "DELETE" });
		// A note someone already removed is gone either way.
		if (!response.ok && response.status !== 404) throw new Error("Note could not be deleted");
		setNotes((current) => current.filter((item) => item.id !== noteId));
	}

	return { notes, loading, add, update, remove };
}

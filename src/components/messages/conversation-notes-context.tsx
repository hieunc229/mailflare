"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { ConversationNote } from "@/lib/notes/types";
import type { ConversationNotesProviderProps, ConversationNotesState } from "./conversation-notes-types";

const ConversationNotesContext = createContext<ConversationNotesState | null>(null);

/**
 * The notes of the open conversation, shared by the toolbar button, the notes
 * under the subject and each email's menu. Refetches when mail changes.
 */
export function ConversationNotesProvider({ messageId, emails, children }: ConversationNotesProviderProps) {
	const [notes, setNotes] = useState<ConversationNote[]>([]);
	const [loading, setLoading] = useState(true);
	const [open, setOpen] = useState(false);
	const [attachTo, setAttachTo] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [adding, setAdding] = useState(false);
	const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
	const [focusRequest, setFocusRequest] = useState(0);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		let refreshTimer: number | null = null;
		async function load() {
			try {
				const response = await authFetch(`/api/messages/${messageId}/notes`);
				const data = (await response.json().catch(() => null)) as { notes?: ConversationNote[] } | null;
				if (!cancelled && response.ok) setNotes(data?.notes ?? []);
			} catch {
				// Keep what is on screen; the next change event tries again.
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

	const startNote = useCallback((target?: string) => {
		setAttachTo(target ?? null);
		setOpen(true);
		setFocusRequest((count) => count + 1);
	}, []);

	const focusHandled = useCallback(() => setFocusRequest(0), []);

	const setEditDraft = useCallback((noteId: string, html: string | null) => {
		setEditDrafts((current) => {
			const next = { ...current };
			if (html === null) delete next[noteId];
			else next[noteId] = html;
			return next;
		});
	}, []);

	const add = useCallback(async (html: string) => {
		setAdding(true);
		try {
			const note = await sendNote(`/api/messages/${attachTo ?? messageId}/notes`, "POST", { html, attachToMessage: attachTo !== null });
			if (!mounted.current) return;
			setNotes((current) => [...current, note]);
			setAttachTo(null);
			setDraft("");
		} finally {
			if (mounted.current) setAdding(false);
		}
	}, [attachTo, messageId]);

	const update = useCallback(async (noteId: string, html: string) => {
		const note = await sendNote(`/api/messages/${messageId}/notes/${noteId}`, "PATCH", { html });
		if (!mounted.current) return;
		setNotes((current) => current.map((item) => (item.id === noteId ? note : item)));
		setEditDraft(noteId, null);
	}, [messageId, setEditDraft]);

	const remove = useCallback(async (noteId: string) => {
		const response = await authFetch(`/api/messages/${messageId}/notes/${noteId}`, { method: "DELETE" });
		if (!response.ok && response.status !== 404) throw new Error("Note delete failed");
		if (!mounted.current) return;
		setNotes((current) => current.filter((item) => item.id !== noteId));
		setEditDraft(noteId, null);
	}, [messageId, setEditDraft]);

	const emailById = useMemo(() => new Map(emails.map((item) => [item.id, item])), [emails]);
	const email = useCallback((id: string) => emailById.get(id), [emailById]);

	const value = useMemo<ConversationNotesState>(
		() => ({ notes, messageId, loading, open, setOpen, attachTo, setAttachTo, startNote, focusRequest, focusHandled, draft, setDraft, adding, editDrafts, setEditDraft, email, add, update, remove }),
		[notes, messageId, loading, open, attachTo, startNote, focusRequest, focusHandled, draft, adding, editDrafts, setEditDraft, email, add, update, remove],
	);
	return <ConversationNotesContext.Provider value={value}>{children}</ConversationNotesContext.Provider>;
}

/** The open conversation's notes; null outside a conversation page. */
export function useConversationNotes(): ConversationNotesState | null {
	return useContext(ConversationNotesContext);
}

async function sendNote(url: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<ConversationNote> {
	const response = await authFetch(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await response.json().catch(() => null)) as { note?: ConversationNote; error?: string } | null;
	if (!response.ok || !data?.note) throw new Error(data?.error ?? "Note save failed");
	return data.note;
}

"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { Label, LabelChip } from "./types";

const LABELS_CHANGED_EVENT = "mailflare:labels-changed";

/** Tells every label list on screen, and the message lists showing label names, to reload. */
export function announceLabelsChanged() {
	window.dispatchEvent(new Event(LABELS_CHANGED_EVENT));
	window.dispatchEvent(new Event("mailflare:messages-changed"));
}

async function readError(response: Response, fallback: string) {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	return typeof body?.error === "string" ? body.error : fallback;
}

/**
 * The labels of a mailbox, reloaded whenever a label is created, renamed or deleted.
 * ponytail: one request per mounted consumer; share a cache like folders/client.ts if that shows up.
 */
export function useMailboxLabels(mailboxId: string | null | undefined): Label[] {
	const [state, setState] = useState<{ mailboxId: string | null; labels: Label[] }>({ mailboxId: null, labels: [] });
	useEffect(() => {
		if (!mailboxId) return;
		let cancelled = false;
		const load = () => {
			authFetch(`/api/labels?${new URLSearchParams({ mailboxId })}`, { cache: "no-store" })
				.then((response) => (response.ok ? response.json() as Promise<{ labels?: Label[] }> : { labels: [] }))
				.then((data) => {
					if (!cancelled) setState({ mailboxId, labels: data.labels ?? [] });
				})
				.catch(() => {});
		};
		load();
		window.addEventListener(LABELS_CHANGED_EVENT, load);
		return () => {
			cancelled = true;
			window.removeEventListener(LABELS_CHANGED_EVENT, load);
		};
	}, [mailboxId]);
	return state.mailboxId === mailboxId ? state.labels : [];
}

export async function createLabel(mailboxId: string, name: string, color: string): Promise<Label> {
	const response = await authFetch("/api/labels", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, name, color }),
	});
	if (!response.ok) throw new Error(await readError(response, "Unable to create the label"));
	const { label } = (await response.json()) as { label: Label };
	announceLabelsChanged();
	return label;
}

export async function updateLabel(labelId: string, input: { name?: string; color?: string }): Promise<void> {
	const response = await authFetch(`/api/labels/${encodeURIComponent(labelId)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) throw new Error(await readError(response, "Unable to save the label"));
	announceLabelsChanged();
}

export async function deleteLabel(labelId: string): Promise<void> {
	const response = await authFetch(`/api/labels/${encodeURIComponent(labelId)}`, { method: "DELETE" });
	if (!response.ok) throw new Error(await readError(response, "Unable to delete the label"));
	announceLabelsChanged();
}

/** Puts a label on the conversation of `messageId` or takes it off; returns the conversation's labels. */
export async function setConversationLabel(messageId: string, labelId: string, applied: boolean): Promise<LabelChip[]> {
	const response = await authFetch(`/api/messages/${encodeURIComponent(messageId)}/labels`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ labelId, applied }),
	});
	if (!response.ok) throw new Error(await readError(response, "Unable to change the label"));
	const { labels } = (await response.json()) as { labels: LabelChip[] };
	window.dispatchEvent(new Event("mailflare:messages-changed"));
	return labels;
}

export async function getConversationLabels(messageId: string): Promise<LabelChip[]> {
	const response = await authFetch(`/api/messages/${encodeURIComponent(messageId)}/labels`, { cache: "no-store" });
	if (!response.ok) return [];
	const { labels } = (await response.json()) as { labels?: LabelChip[] };
	return labels ?? [];
}

"use client";

import { useEffect, useState } from "react";
import { getConversationLabels } from "@/lib/labels/client";
import type { LabelChip } from "@/lib/labels/types";

/** The labels on the open conversation; reloads when mail or labels change anywhere on the page. */
export function useConversationLabels(messageId: string, enabled = true) {
	const [state, setState] = useState<{ messageId: string; labels: LabelChip[] } | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		const load = () => {
			void getConversationLabels(messageId).then((labels) => {
				if (!cancelled) setState({ messageId, labels });
			}).catch(() => {});
		};
		load();
		window.addEventListener("mailflare:messages-changed", load);
		return () => {
			cancelled = true;
			window.removeEventListener("mailflare:messages-changed", load);
		};
	}, [messageId, enabled]);
	const labels = state?.messageId === messageId ? state.labels : [];
	return { labels, setLabels: (next: LabelChip[]) => setState({ messageId, labels: next }) };
}

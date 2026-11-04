"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SendNoticeParts } from "./send-notice-utils";

export type ComposeNoticeAction = { label: string; onClick: () => void | Promise<void> };

export type ComposeNoticePoll = {
	messageId: string;
	/** Called once the message is sent, failed or returned to Drafts. */
	onStatus: (status: "sent" | "failed" | "cancelled") => void;
};

export type ComposeNoticeOptions = {
	actions?: ComposeNoticeAction[];
	parts?: SendNoticeParts;
	tone?: "success" | "error";
	durationMs?: number;
	countdown?: { endAt: number };
	/** Called once when the countdown reaches zero; the callback decides what replaces the toast. */
	onCountdownEnd?: () => void;
	/** Polls the message's delivery status while the toast is visible. */
	poll?: ComposeNoticePoll;
};

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	openComposer: () => void;
	openDraftComposer: (draftId: string) => void;
	closeComposer: () => void;
	notice: ComposeNotice | null;
	/** Shows a toast and returns its id; `actions` adds buttons, `durationMs` overrides the default 3.2s. */
	showNotice: (message: string | null, options?: ComposeNoticeOptions) => number | null;
	/** Whether a notice id is still the latest one; async actions use it to avoid replacing a newer toast. */
	isCurrentNotice: (id: number) => boolean;
};

export type ComposeNotice = {
	id: number;
	message: string;
	parts?: SendNoticeParts;
	actions: ComposeNoticeAction[];
	tone: "success" | "error";
	durationMs: number;
	countdown?: { endAt: number };
	onCountdownEnd?: () => void;
	poll?: ComposeNoticePoll;
};

const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose() {
	const ctx = useContext(ComposeContext);
	if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
	return ctx;
}

export function ComposeProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [draftId, setDraftId] = useState<string | null>(null);
	const opener = useRef<HTMLElement | null>(null);

	function rememberOpener() {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}
	const [notice, setNotice] = useState<ComposeNotice | null>(null);
	const noticeId = useRef(0);

	useEffect(() => {
		if (!notice) return;
		// A countdown notice normally replaces itself when it reaches zero. The extra
		// grace keeps that transition ahead of dismissal and still clears the notice if
		// the layout has no toast mounted.
		const timeout = Math.max(0, notice.durationMs) + (notice.onCountdownEnd ? 2000 : 0);
		const timer = setTimeout(() => setNotice(null), timeout);
		return () => clearTimeout(timer);
	}, [notice]);

	return (
		<ComposeContext.Provider
			value={{
				open,
				draftId,
				openComposer: () => {
					rememberOpener();
					setDraftId(null);
					setOpen(true);
				},
				openDraftComposer: (nextDraftId) => {
					if (!open) rememberOpener();
					setDraftId(nextDraftId);
					setOpen(true);
				},
				closeComposer: () => {
					setOpen(false);
					setDraftId(null);
					const previous = opener.current;
					opener.current = null;
					if (previous) requestAnimationFrame(() => { if (previous.isConnected) previous.focus(); });
				},
				notice,
				showNotice: (message, options) => {
					const id = ++noticeId.current;
					setNotice(message ? {
						id,
						message,
						parts: options?.parts,
						actions: options?.actions ?? [],
						tone: options?.tone ?? "success",
						durationMs: options?.durationMs ?? 3200,
						countdown: options?.countdown,
						onCountdownEnd: options?.onCountdownEnd,
						poll: options?.poll,
					} : null);
					return message ? id : null;
				},
				isCurrentNotice: (id) => noticeId.current === id,
			}}
		>
			{children}
		</ComposeContext.Provider>
	);
}

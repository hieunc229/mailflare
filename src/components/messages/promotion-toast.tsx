"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { applyAlwaysForSender } from "@/lib/promotions/move-client";
import { isToastPaused, remainingAfter } from "@/lib/promotions/move-utils";
import { cn } from "@/lib/utils";
import {
	dismissPromotionToast,
	getPromotionToast,
	subscribePromotionToast,
	type PromotionToastEntry,
} from "./promotion-toast-store";

/** Long enough to reach with the keyboard; hover or focus stops the countdown altogether (WCAG 2.2.1). */
const TOAST_DURATION_MS = 15_000;

function focusMainSurface() {
	const main = document.getElementById("main-content");
	if (!main) return;
	if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
	main.focus({ preventScroll: true });
}

/** The result of "Move to Promotions / Inbox", with an optional "Always for <sender>" follow-up. */
export function PromotionToast() {
	const { t } = useLanguage();
	const toast = useSyncExternalStore(subscribePromotionToast, getPromotionToast, () => null);
	// One live region that is always mounted, so assistive technology announces each new message.
	const text = toast ? t(toast.copy.key, toast.copy.vars) : "";
	return (
		<>
			<div role={toast?.tone === "error" ? "alert" : "status"} aria-live={toast?.tone === "error" ? "assertive" : "polite"} aria-atomic="true" className="sr-only">
				{text && <span key={toast?.id + text}>{text}</span>}
			</div>
			{toast && <ToastBody key={toast.id} toast={toast} text={text} />}
		</>
	);
}

function ToastBody({ toast, text }: { toast: PromotionToastEntry; text: string }) {
	const { t } = useLanguage();
	const [holds, setHolds] = useState({ hover: false, focus: false });
	const paused = isToastPaused(holds) || !!toast.always?.working;
	const remaining = useRef(TOAST_DURATION_MS);
	// A new result (after "Always for ...") gets a fresh countdown.
	const stamp = `${toast.copy.key}:${!!toast.always}`;
	// Declared before the timer effect: on a change its cleanup runs first, then this reset, then the timer restarts.
	useEffect(() => {
		remaining.current = TOAST_DURATION_MS;
	}, [stamp]);

	useEffect(() => {
		if (paused) return;
		const startedAt = Date.now();
		const timer = window.setTimeout(() => dismissPromotionToast(toast.id), remaining.current);
		return () => {
			window.clearTimeout(timer);
			remaining.current = remainingAfter(remaining.current, startedAt, Date.now());
		};
	}, [paused, stamp, toast.id]);

	function dismiss() {
		dismissPromotionToast(toast.id);
		focusMainSurface();
	}

	const always = toast.always;
	const buttonClass = "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/20 px-2.5 py-1 font-semibold hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900 max-md:min-h-11";
	return (
		<section
			role="region"
			aria-label={t("promotions.toast.region")}
			tabIndex={0}
			onPointerEnter={() => setHolds((current) => ({ ...current, hover: true }))}
			onPointerLeave={() => setHolds((current) => ({ ...current, hover: false }))}
			onFocusCapture={() => setHolds((current) => ({ ...current, focus: true }))}
			onBlurCapture={(event) => {
				const next = event.relatedTarget;
				if (!next || !event.currentTarget.contains(next as Node)) setHolds((current) => ({ ...current, focus: false }));
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") dismiss();
			}}
			className={cn(
				"fixed z-30 flex w-[calc(100vw-3rem)] items-start gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white shadow-lg ring-1 ring-black/10 backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
				"inset-x-6 bottom-[max(5rem,calc(env(safe-area-inset-bottom,0px)+4.5rem))]",
				"md:bottom-6 md:w-[min(26rem,calc(100vw-var(--sidebar-width,260px)-3rem))] md:[inset-inline-end:auto] md:[inset-inline-start:calc(var(--sidebar-width,260px)+1.5rem)]",
				toast.tone === "error" ? "bg-red-700" : toast.tone === "warn" ? "bg-amber-800" : "bg-neutral-900/95",
			)}
		>
			<p className="min-w-0 flex-1 break-words py-0.5">{text}</p>
			{always && (
				<button
					type="button"
					aria-disabled={always.working || undefined}
					aria-label={t(always.target === "inbox" ? "promotions.always.labelInbox" : "promotions.always.labelPromotions", { sender: always.senderAddress })}
					onClick={() => { if (!always.working) void applyAlwaysForSender(toast.id, always); }}
					className={cn(buttonClass, always.working && "cursor-wait opacity-70")}
				>
					{always.working && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
					<span className="max-w-48 truncate">{t("promotions.always.button", { sender: always.senderAddress })}</span>
				</button>
			)}
			<button
				type="button"
				onClick={dismiss}
				aria-label={t("promotions.toast.dismiss")}
				className="-m-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base leading-none text-white/75 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900 max-md:h-11 max-md:w-11"
			>
				<span aria-hidden="true">×</span>
			</button>
		</section>
	);
}

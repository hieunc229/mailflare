"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLanguage } from "@/components/language-provider";
import { Loader2 } from "@/components/icons";
import { MessageActionRequestError, undoMessageAction } from "@/lib/messages/actions/client";
import type {
	MessageActionSkipped,
	ReversibleMessageAction,
} from "@/lib/messages/actions/types";
import {
	beginUndoToast,
	completeUndoToast,
	dismissUndoToast,
	failUndoToast,
	getUndoAnnouncements,
	getUndoToasts,
	hideUndoToast,
	partialUndoToast,
	pauseUndoToast,
	pauseUndoToasts,
	resumeUndoToast,
	resumeUndoToasts,
	subscribeUndoToasts,
} from "@/lib/messages/actions/undo-store";
import type {
	UndoToastAnnouncement,
	UndoToastEntry,
	UndoToastFailure,
	UndoToastFailureKind,
} from "@/lib/messages/actions/undo-store";
import type { Translator } from "@/lib/i18n/utils";
import type { TranslationKey } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

const ACTION_LABELS: Record<ReversibleMessageAction, TranslationKey> = {
	archive: "undo.label.archive",
	trash: "undo.label.trash",
	spam: "undo.label.spam",
	inbox: "undo.label.inbox",
	folder: "undo.label.folder",
	read: "undo.label.read",
	unread: "undo.label.unread",
	star: "undo.label.star",
	unstar: "undo.label.unstar",
	snooze: "undo.label.snooze",
	unsnooze: "undo.label.unsnooze",
};

const FAILURE_LABELS: Record<UndoToastFailureKind, TranslationKey> = {
	expired: "undo.failed.expired",
	unavailable: "undo.failed.unavailable",
	stale: "undo.failed.stale",
	network: "undo.failed.network",
	server: "undo.failed.server",
};

const EMPTY_TOASTS: UndoToastEntry[] = [];
const EMPTY_ANNOUNCEMENTS: UndoToastAnnouncement[] = [];
const BLOCKING_OVERLAY_SELECTOR = [
	'[role="dialog"][aria-modal="true"]',
	'[aria-modal="true"]',
	"dialog[open]",
	".dialog-overlay",
	'[data-mobile-menu][aria-expanded="true"]',
].join(", ");
const COMPOSE_SELECTOR = "[data-compose-surface]";
const INTERACTION_SELECTOR = `${BLOCKING_OVERLAY_SELECTOR}, #main-content[inert], #main-content[aria-hidden="true"]`;

/** A modal or mobile sidebar owns focus and must not be bypassed by toast cleanup. */
function hasBlockingOverlay() {
	if (typeof document === "undefined") return false;
	return !!document.querySelector(BLOCKING_OVERLAY_SELECTOR);
}

/** A modal, mobile sidebar, assistant full-size view or hidden main surface owns interaction. */
function hasInteractionHold() {
	if (typeof document === "undefined") return false;
	return !!document.querySelector(INTERACTION_SELECTOR);
}

function hasComposeSurface() {
	if (typeof document === "undefined") return false;
	return !!document.querySelector(COMPOSE_SELECTOR);
}

function subscribeInteractionState(onChange: () => void) {
	if (typeof document === "undefined") return () => undefined;
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["role", "aria-modal", "class", "open", "aria-expanded", "aria-hidden", "inert", "data-compose-surface"],
	});
	return () => observer.disconnect();
}

function getToastHoldState() {
	const interaction = hasInteractionHold() ? 1 : 0;
	const composing = hasComposeSurface() ? 2 : 0;
	return interaction | composing;
}

function useToastHolds() {
	return useSyncExternalStore(subscribeInteractionState, getToastHoldState, () => 0);
}

function failureFromError(error: unknown): UndoToastFailure {
	if (error instanceof MessageActionRequestError) {
		if (error.status === 410) return { kind: "expired", retryable: false };
		if (error.status === 404) return { kind: "unavailable", retryable: false };
		if (error.status === 409 || error.status === 412 || error.status === 422) {
			return { kind: "stale", retryable: false };
		}
		if (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500) {
			return { kind: "server", retryable: true };
		}
		return { kind: "server", retryable: false };
	}
	return { kind: "network", retryable: true };
}

function failureFromSkipped(skipped: MessageActionSkipped[]): UndoToastFailure {
	const reasons = new Set(skipped.map((item) => item.reason));
	if (reasons.has("failed")) return { kind: "server", retryable: true };
	if (reasons.has("stale")) return { kind: "stale", retryable: false };
	if (reasons.has("not_found") || reasons.has("forbidden") || reasons.has("invalid_target") || reasons.has("not_applicable")) {
		return { kind: "unavailable", retryable: false };
	}
	return { kind: "server", retryable: false };
}

function actionLabel(t: Translator, action: ReversibleMessageAction) {
	return t(ACTION_LABELS[action]);
}

function appliedText(t: Translator, action: ReversibleMessageAction, count: number, skipped = 0) {
	const label = actionLabel(t, action);
	const text = count > 1 ? t("undo.bulk", { action: label, count }) : label;
	return skipped > 0 ? `${text}. ${t("undo.partial", { applied: count, total: count + skipped })}` : text;
}

function announcementText(t: Translator, announcement: UndoToastAnnouncement) {
	if (announcement.kind === "undo-success") {
		return t("undo.successAnnouncement", { action: actionLabel(t, announcement.action) });
	}
	if (announcement.kind === "undo-partial") {
		return t("undo.partialRestored", {
			restored: announcement.restored ?? 0,
			total: announcement.count,
		});
	}
	if (announcement.kind === "undo-failed") {
		const reason = announcement.failure ? t(FAILURE_LABELS[announcement.failure.kind]) : "";
		return reason || t("undo.failed");
	}
	return appliedText(t, announcement.action, announcement.count, announcement.skipped);
}

function isAvailableSurface(element: HTMLElement) {
	if (!element.isConnected || element.closest("[inert], [hidden], [aria-hidden=\"true\"]")) return false;
	const style = window.getComputedStyle(element);
	return style.display !== "none" && style.visibility !== "hidden";
}

function focusVisibleAppSurface() {
	const selectors = ["#main-content", "#email-assistant-panel", "[data-mobile-menu]", "main", '[role="main"]'];
	for (const selector of selectors) {
		const element = document.querySelector<HTMLElement>(selector);
		if (!element || !isAvailableSurface(element)) continue;
		if (!element.hasAttribute("tabindex") && !["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
			element.tabIndex = -1;
		}
		element.focus({ preventScroll: true });
		return;
	}
}

/** Keep keyboard focus in the remaining receipt, or fall back to the app surface. */
function restoreFocusAfterAction(entryId: number) {
	if (typeof window === "undefined") return;
	window.setTimeout(() => {
		const active = document.activeElement;
		const activeInRegion = active instanceof HTMLElement && !!active.closest("[data-undo-region]");
		if (active && active !== document.body && (active as HTMLElement).isConnected) {
			if (!activeInRegion) resumeUndoToasts("region");
			return;
		}
		if (hasBlockingOverlay()) {
			resumeUndoToasts("region");
			return;
		}
		const toast = document.querySelector<HTMLElement>(`[data-undo-toast-id="${entryId}"]`);
		if (toast && isAvailableSurface(toast)) {
			const dismiss = toast.querySelector<HTMLElement>("[data-undo-dismiss]");
			if (dismiss && !dismiss.hasAttribute("disabled") && !dismiss.hasAttribute("aria-disabled")) {
				dismiss.focus({ preventScroll: true });
				if (!document.activeElement?.closest("[data-undo-region]")) resumeUndoToasts("region");
				return;
			}
			if (!toast.hasAttribute("tabindex")) toast.tabIndex = -1;
			toast.focus({ preventScroll: true });
			if (!document.activeElement?.closest("[data-undo-region]")) resumeUndoToasts("region");
			return;
		}
		resumeUndoToasts("region");
		focusVisibleAppSurface();
	}, 0);
}

/** Independent stack for message-action undo; compose's single send notice is untouched. */
export function UndoToasts() {
	const { t } = useLanguage();
	const toasts = useSyncExternalStore(subscribeUndoToasts, getUndoToasts, () => EMPTY_TOASTS);
	const announcements = useSyncExternalStore(subscribeUndoToasts, getUndoAnnouncements, () => EMPTY_ANNOUNCEMENTS);
	const holdState = useToastHolds();
	const interactionHeld = (holdState & 1) !== 0;
	const pauseHeld = holdState !== 0;
	const [polite, setPolite] = useState<{ text: string; sequence: number } | null>(null);
	const [assertive, setAssertive] = useState<{ text: string; sequence: number } | null>(null);
	// A late mount must not replay announcements already made.
	const seenAnnouncement = useRef(announcements.at(-1)?.sequence ?? 0);

	useEffect(() => {
		if (pauseHeld) {
			pauseUndoToasts("interaction");
			resumeUndoToasts("region");
		} else {
			resumeUndoToasts("interaction");
		}
		return () => resumeUndoToasts("interaction");
	}, [pauseHeld]);

	useEffect(() => {
		if (toasts.length === 0) resumeUndoToasts("region");
	}, [toasts.length]);

	useEffect(() => () => resumeUndoToasts("region"), []);

	useEffect(() => {
		const latest = announcements.at(-1)?.sequence ?? 0;
		const fresh = announcements.filter((item) => item.sequence > seenAnnouncement.current);
		if (fresh.length === 0) return;
		seenAnnouncement.current = latest;
		const politeText = fresh
			.filter((item) => item.kind !== "undo-failed" && item.kind !== "undo-partial")
			.map((item) => announcementText(t, item))
			.join(" ");
		const assertiveText = fresh
			.filter((item) => item.kind === "undo-failed" || item.kind === "undo-partial")
			.map((item) => announcementText(t, item))
			.join(" ");
		if (politeText) setPolite({ text: politeText, sequence: latest });
		if (assertiveText) setAssertive({ text: assertiveText, sequence: latest });
	}, [announcements, t]);

	async function undo(entry: UndoToastEntry) {
		const current = getUndoToasts().find((item) => item.id === entry.id);
		if (!current) return;
		if (current.status !== "idle" && !(current.status === "failed" && current.failure?.retryable)) return;
		beginUndoToast(current.id);
		try {
			const result = await undoMessageAction(current);
			const total = current.records.length;
			const restoredIds = new Set(result.restored);
			const restored = current.records.filter((record) => restoredIds.has(record.id)).length;
			const undoSkipCount = Math.max(result.skipped.length, total - restored);
			if (restored === 0) {
				const failure = failureFromSkipped(result.skipped);
				failUndoToast(current.id, failure);
				if (!failure.retryable) restoreFocusAfterAction(current.id);
			} else if (restored < total || result.skipped.length > 0) {
				partialUndoToast(current.id, {
					restored,
					skipped: undoSkipCount,
					skippedReasons: result.skipped.map((item) => item.reason),
				});
				restoreFocusAfterAction(current.id);
			} else {
				completeUndoToast(current.id);
				restoreFocusAfterAction(current.id);
			}
		} catch (error) {
			const failure = failureFromError(error);
			failUndoToast(current.id, failure);
			if (!failure.retryable) restoreFocusAfterAction(current.id);
		}
	}

	function dismiss(entry: UndoToastEntry) {
		dismissUndoToast(entry.id);
		restoreFocusAfterAction(entry.id);
	}

	function hide(entry: UndoToastEntry) {
		hideUndoToast(entry.id);
		restoreFocusAfterAction(entry.id);
	}

	return (
		<>
			<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
				{polite && <span key={polite.sequence}>{polite.text}</span>}
			</div>
			<div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
				{assertive && <span key={assertive.sequence}>{assertive.text}</span>}
			</div>
			{toasts.length > 0 && (
				<section
					role="region"
					aria-label={t("undo.region")}
					tabIndex={0}
					data-undo-region
					inert={interactionHeld}
					aria-hidden={interactionHeld || undefined}
					onFocusCapture={() => pauseUndoToasts("region")}
					onBlurCapture={(event) => {
						const next = event.relatedTarget;
						if (!next || !event.currentTarget.contains(next as Node)) {
							resumeUndoToasts("region");
						}
					}}
					className={cn(
						"pointer-events-none fixed z-30 flex max-h-[calc(100dvh-6rem)] w-[calc(100vw-3rem)] flex-col gap-2 overflow-y-auto overscroll-contain rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/60",
						"inset-x-6 bottom-[max(5rem,calc(env(safe-area-inset-bottom,0px)+4.5rem))]",
						"md:bottom-6 md:w-[min(24rem,calc(100vw-var(--sidebar-width,260px)-3rem))] md:[inset-inline-end:auto] md:[inset-inline-start:calc(var(--sidebar-width,260px)+1.5rem)]",
					)}
				>
					{toasts.map((entry) => {
						const label = actionLabel(t, entry.action);
						const messageId = `undo-toast-${entry.id}-message`;
						const failed = entry.status === "failed";
						const partial = entry.status === "partial";
						const undoing = entry.status === "undoing";
						const retryable = failed && entry.failure?.retryable;
						const primary = entry.status === "idle" || undoing || retryable;
						const mainText = failed
							? t("undo.failed")
							: partial
								? t("undo.partialRestored", {
										restored: entry.restored ?? 0,
										total: entry.records.length,
									})
								: appliedText(t, entry.action, entry.records.length, entry.skipped);
						return (
							<div
								key={entry.id}
								role="group"
								aria-labelledby={messageId}
								aria-busy={undoing || undefined}
								data-undo-toast-id={entry.id}
								onPointerEnter={() => pauseUndoToast(entry.id, "hover")}
								onPointerLeave={() => resumeUndoToast(entry.id, "hover")}
								className={cn(
									"flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white shadow-lg ring-1 ring-black/10 backdrop-blur-sm",
									"pointer-events-auto focus-within:ring-2 focus-within:ring-white/80",
									failed ? "bg-red-700" : partial ? "bg-amber-800" : "bg-neutral-900/95",
									interactionHeld && "pointer-events-none",
								)}
							>
								<div id={messageId} className="min-w-0 flex-1 py-0.5">
									<p className="break-words">{mainText}</p>
									{entry.context && !failed && !partial && (
										<p className="mt-0.5 break-words text-xs font-normal text-white/80">{entry.context}</p>
									)}
									{failed && entry.failure && (
										<p className="mt-0.5 text-xs font-normal text-white/85">
											{t(FAILURE_LABELS[entry.failure.kind])}
										</p>
									)}
									{partial && (
										<p className="mt-0.5 text-xs font-normal text-white/85">{label}</p>
									)}
								</div>
								{primary && (
									<button
										type="button"
										onClick={() => { if (!undoing) void undo(entry); }}
										aria-disabled={undoing || undefined}
										aria-describedby={messageId}
										className={cn(
											"inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-md bg-white/20 px-2.5 py-1 font-semibold hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900",
											undoing && "cursor-wait opacity-70 hover:bg-white/20",
										)}
									>
										{undoing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
										{undoing ? t("undo.undoing") : retryable ? t("undo.retry") : t("undo.button")}
									</button>
								)}
								{undoing ? (
									<button
										type="button"
										onClick={() => hide(entry)}
										aria-label={t("undo.hidePending")}
										title={t("undo.hidePending")}
										aria-describedby={messageId}
										className="-m-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-base leading-none text-white/75 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
									>
										<span aria-hidden="true">×</span>
									</button>
								) : (
									<button
										type="button"
										onClick={() => dismiss(entry)}
										data-undo-dismiss
										aria-label={t("undo.dismiss")}
										aria-describedby={messageId}
										className="-m-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-base leading-none text-white/75 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
									>
										<span aria-hidden="true">×</span>
									</button>
								)}
							</div>
						);
					})}
				</section>
			)}
		</>
	);
}

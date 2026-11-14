"use client";

import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import type {
	MessageActionRecord,
	MessageActionSkipReason,
	ReversibleMessageAction,
} from "./types";

export type UndoToastStatus = "idle" | "undoing" | "failed" | "partial";

export type UndoToastFailureKind =
	| "expired"
	| "unavailable"
	| "stale"
	| "network"
	| "server";

export type UndoToastFailure = {
	kind: UndoToastFailureKind;
	/** Only transient transport/server failures offer Retry; expiry and stale states do not. */
	retryable: boolean;
};

export type UndoToastEntry = {
	id: number;
	action: ReversibleMessageAction;
	records: MessageActionRecord[];
	undoToken: string;
	/** Messages the original action could not apply. */
	skipped: number;
	status: UndoToastStatus;
	/** Optional human-readable folder name or snooze time supplied by the caller. */
	context?: string;
	/** Set only while this entry waits for a visible slot; bounds stale queue lifetime. */
	queuedAt?: number;
	failure?: UndoToastFailure;
	/** Set when Undo restored only some of the action's messages. */
	restored?: number;
	undoSkipped?: number;
	undoSkippedReasons?: MessageActionSkipReason[];
};

export type UndoToastAnnouncementKind =
	| "applied"
	| "undo-success"
	| "undo-partial"
	| "undo-failed";

export type UndoToastAnnouncement = {
	sequence: number;
	kind: UndoToastAnnouncementKind;
	action: ReversibleMessageAction;
	count: number;
	skipped?: number;
	restored?: number;
	failure?: UndoToastFailure;
};

export const UNDO_TOAST_LIMITS = Object.freeze({
	visible: 4,
	/** Bounded FIFO spillover; a queued entry's countdown starts only when it becomes visible. */
	queued: 12,
});

/** Long enough to reach the notification with a keyboard, and it pauses while hovered, focused or hidden. */
export const UNDO_WINDOW_MS = 20_000;

/** Queued entries must be promoted before their signed token can expire (server maximum: 10 minutes). */
export const QUEUE_MAX_AGE_MS = 8 * 60_000;

const MAX_ANNOUNCEMENTS = 20;

let entries: UndoToastEntry[] = [];
let queued: UndoToastEntry[] = [];
let announcements: UndoToastAnnouncement[] = [];
let nextId = 0;
let nextAnnouncementId = 0;
let pageHidden = false;
let lifecycleBound = false;
let queueExpiryTimer: number | null = null;
const listeners = new Set<() => void>();
const timers = new Map<number, { handle: number; deadline: number }>();
const remaining = new Map<number, number>();
const pauseReasons = new Map<number, Set<string>>();
const globalPauseReasons = new Set<string>();

function emit() {
	for (const listener of listeners) listener();
}

function entryById(id: number): UndoToastEntry | undefined {
	return entries.find((entry) => entry.id === id) ?? queued.find((entry) => entry.id === id);
}

function replaceEntry(id: number, update: (entry: UndoToastEntry) => UndoToastEntry) {
	entries = entries.map((entry) => (entry.id === id ? update(entry) : entry));
	queued = queued.map((entry) => (entry.id === id ? update(entry) : entry));
}

function announce(announcement: Omit<UndoToastAnnouncement, "sequence">) {
	announcements = [
		...announcements.slice(-(MAX_ANNOUNCEMENTS - 1)),
		{ ...announcement, sequence: ++nextAnnouncementId },
	];
}

function announceApplied(entry: UndoToastEntry) {
	announce({
		kind: "applied",
		action: entry.action,
		count: entry.records.length,
		skipped: entry.skipped,
	});
}

function timerIsHeld(id: number): boolean {
	return pageHidden
		|| globalPauseReasons.size > 0
		|| (pauseReasons.get(id)?.size ?? 0) > 0;
}

function clearTimer(id: number) {
	if (typeof window === "undefined") return;
	const timer = timers.get(id);
	if (timer) window.clearTimeout(timer.handle);
	timers.delete(id);
	remaining.delete(id);
}

function pauseTimer(id: number) {
	const timer = timers.get(id);
	if (!timer) return;
	remaining.set(id, Math.max(0, timer.deadline - Date.now()));
	window.clearTimeout(timer.handle);
	timers.delete(id);
}

function scheduleTimer(id: number, delay: number) {
	if (typeof window === "undefined") return;
	if (timerIsHeld(id)) {
		remaining.set(id, delay);
		return;
	}
	const existing = timers.get(id);
	if (existing) window.clearTimeout(existing.handle);
	remaining.set(id, delay);
	const handle = window.setTimeout(() => {
		timers.delete(id);
		remaining.delete(id);
		// Focus may arrive between the deadline and this callback.
		if (isToastFocused(id)) {
			remaining.set(id, 0);
			pauseUndoToast(id, "focus");
			return;
		}
		dismissUndoToast(id);
	}, delay);
	timers.set(id, { handle, deadline: Date.now() + delay });
}

function isToastFocused(id: number): boolean {
	if (typeof document === "undefined") return false;
	const toast = document.querySelector(`[data-undo-toast-id="${id}"]`);
	return !!toast && toast.contains(document.activeElement);
}

function startVisibleTimer(id: number) {
	scheduleTimer(id, UNDO_WINDOW_MS);
}

function promoteQueued() {
	if (entries.length >= UNDO_TOAST_LIMITS.visible) return;
	pruneExpiredQueued(Date.now());
	if (queued.length === 0) {
		scheduleQueueExpiry();
		return;
	}
	const promoted = { ...queued[0] };
	delete promoted.queuedAt;
	queued = queued.slice(1);
	entries = [...entries, promoted];
	startVisibleTimer(promoted.id);
	announceApplied(promoted);
	scheduleQueueExpiry();
}

function clearQueueExpiry() {
	if (queueExpiryTimer !== null && typeof window !== "undefined") {
		window.clearTimeout(queueExpiryTimer);
	}
	queueExpiryTimer = null;
}

function pruneExpiredQueued(now: number): boolean {
	const next = queued.filter((entry) => now - (entry.queuedAt ?? now) < QUEUE_MAX_AGE_MS);
	if (next.length === queued.length) return false;
	queued = next;
	return true;
}

function scheduleQueueExpiry() {
	clearQueueExpiry();
	if (typeof window === "undefined" || queued.length === 0) return;
	const nextAt = Math.min(...queued.map((entry) => (entry.queuedAt ?? Date.now()) + QUEUE_MAX_AGE_MS));
	const delay = Math.max(0, nextAt - Date.now());
	queueExpiryTimer = window.setTimeout(() => {
		queueExpiryTimer = null;
		if (pruneExpiredQueued(Date.now())) emit();
		scheduleQueueExpiry();
	}, delay);
}

function removeEntry(id: number) {
	clearTimer(id);
	pauseReasons.delete(id);
	entries = entries.filter((entry) => entry.id !== id);
	queued = queued.filter((entry) => entry.id !== id);
	promoteQueued();
	scheduleQueueExpiry();
}

function updatePageHidden(hidden: boolean) {
	if (pageHidden === hidden) return;
	pageHidden = hidden;
	if (!hidden && pruneExpiredQueued(Date.now())) emit();
	for (const entry of entries) {
		if (entry.status !== "idle") continue;
		if (hidden) pauseTimer(entry.id);
		else if (!timerIsHeld(entry.id)) scheduleTimer(entry.id, remaining.get(entry.id) ?? UNDO_WINDOW_MS);
	}
	if (!hidden) scheduleQueueExpiry();
}

function bindLifecycle() {
	if (lifecycleBound || typeof window === "undefined") return;
	lifecycleBound = true;
	pageHidden = typeof document !== "undefined" && document.hidden;
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetUndoToasts);
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => updatePageHidden(document.hidden));
	}
}

export function subscribeUndoToasts(listener: () => void) {
	bindLifecycle();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getUndoToasts(): UndoToastEntry[] {
	return entries;
}

/** Entries waiting for a visible slot. Their countdown has not started. */
export function getQueuedUndoToasts(): UndoToastEntry[] {
	return queued;
}

export function getUndoAnnouncements(): UndoToastAnnouncement[] {
	return announcements;
}

function terminalReceiptCandidates(): UndoToastEntry[] {
	return entries
		.filter((entry) => entry.status === "failed" || entry.status === "partial")
		.filter((entry) => !(entry.status === "failed" && entry.failure?.retryable))
		.filter((entry) => !isToastFocused(entry.id))
		.sort((a, b) => a.id - b.id);
}

function oldestTerminalReceipt(): UndoToastEntry | undefined {
	return terminalReceiptCandidates()[0];
}

function oldestRedundantTerminalReceipt(): UndoToastEntry | undefined {
	const terminals = terminalReceiptCandidates();
	return terminals.length > 1 ? terminals[0] : undefined;
}

/** A receipt turning terminal must not leave an older actionable undo stuck in the queue. */
function ensureQueuedVisible() {
	pruneExpiredQueued(Date.now());
	if (queued.length === 0 || entries.length < UNDO_TOAST_LIMITS.visible) return;
	const terminal = oldestRedundantTerminalReceipt();
	if (terminal) removeEntry(terminal.id);
}

/** Adds an independent toast; compose's single send notice is never touched. */
export function showUndoToast(input: {
	action: ReversibleMessageAction;
	records: MessageActionRecord[];
	undoToken?: string;
	skipped?: number;
	/** Generic folder/snooze labels can add a folder name or time without new translation keys. */
	context?: string;
}): number | null {
	if (!input.undoToken || input.records.length === 0 || typeof window === "undefined") return null;
	bindLifecycle();
	const id = ++nextId;
	const entry: UndoToastEntry = {
		id,
		action: input.action,
		records: input.records,
		undoToken: input.undoToken,
		skipped: input.skipped ?? 0,
		status: "idle",
		...(input.context ? { context: input.context } : {}),
	};
	if (entries.length >= UNDO_TOAST_LIMITS.visible) {
		// A terminal receipt yields before a new or queued action does.
		const terminal = oldestTerminalReceipt();
		if (terminal) removeEntry(terminal.id);
	}
	if (entries.length < UNDO_TOAST_LIMITS.visible) {
		entries = [...entries, entry];
		startVisibleTimer(id);
		announceApplied(entry);
	} else {
		// Keep the newest queued notices; the visible stack is never replaced.
		queued = [...queued, { ...entry, queuedAt: Date.now() }].slice(-UNDO_TOAST_LIMITS.queued);
		scheduleQueueExpiry();
	}
	emit();
	return id;
}

export function beginUndoToast(id: number) {
	const entry = entryById(id);
	if (!entry) return;
	clearTimer(id);
	pauseReasons.delete(id);
	replaceEntry(id, (current) => ({
		...current,
		status: "undoing",
		failure: undefined,
		restored: undefined,
		undoSkipped: undefined,
		undoSkippedReasons: undefined,
	}));
	emit();
}

export function failUndoToast(
	id: number,
	failure: UndoToastFailure = { kind: "server", retryable: true },
) {
	const entry = entryById(id);
	if (!entry) return;
	clearTimer(id);
	pauseReasons.delete(id);
	replaceEntry(id, (current) => ({
		...current,
		status: "failed",
		failure,
		restored: undefined,
		undoSkipped: undefined,
		undoSkippedReasons: undefined,
	}));
	announce({ kind: "undo-failed", action: entry.action, count: entry.records.length, failure });
	ensureQueuedVisible();
	emit();
}

/** Keeps a partial result visible instead of reporting full success. */
export function partialUndoToast(
	id: number,
	result: { restored: number; skipped: number; skippedReasons?: MessageActionSkipReason[] },
) {
	const entry = entryById(id);
	if (!entry) return;
	clearTimer(id);
	pauseReasons.delete(id);
	replaceEntry(id, (current) => ({
		...current,
		status: "partial",
		failure: undefined,
		restored: result.restored,
		undoSkipped: result.skipped,
		undoSkippedReasons: result.skippedReasons,
	}));
	announce({
		kind: "undo-partial",
		action: entry.action,
		count: entry.records.length,
		restored: result.restored,
	});
	ensureQueuedVisible();
	emit();
}

/** Removes a successfully undone toast and announces the completion. */
export function completeUndoToast(id: number) {
	const entry = entryById(id);
	if (!entry) return;
	announce({ kind: "undo-success", action: entry.action, count: entry.records.length });
	removeEntry(id);
	emit();
}

export function dismissUndoToast(id: number) {
	if (!entryById(id)) return;
	removeEntry(id);
	emit();
}

/** Hides a pending notice without cancelling the in-flight undo. */
export const hideUndoToast = dismissUndoToast;

export function pauseUndoToast(id: number, reason = "hold") {
	const entry = entryById(id);
	if (!entry || entry.status !== "idle") return;
	const reasons = pauseReasons.get(id) ?? new Set<string>();
	const wasHolding = reasons.size > 0;
	reasons.add(reason);
	pauseReasons.set(id, reasons);
	if (!wasHolding) pauseTimer(id);
}

export function resumeUndoToast(id: number, reason = "hold") {
	const reasons = pauseReasons.get(id);
	if (!reasons) return;
	reasons.delete(reason);
	if (reasons.size > 0) return;
	pauseReasons.delete(id);
	const entry = entryById(id);
	if (!entry || entry.status !== "idle" || !entries.includes(entry) || timerIsHeld(id)) return;
	scheduleTimer(id, remaining.get(id) ?? UNDO_WINDOW_MS);
}

/** Holds every idle countdown while a modal, overlay, region focus or hidden app surface owns interaction. */
export function pauseUndoToasts(reason = "hold") {
	const wasHeld = globalPauseReasons.size > 0;
	globalPauseReasons.add(reason);
	if (wasHeld) return;
	for (const entry of entries) {
		if (entry.status === "idle") pauseTimer(entry.id);
	}
}

export function resumeUndoToasts(reason = "hold") {
	if (!globalPauseReasons.delete(reason) || globalPauseReasons.size > 0) return;
	for (const entry of entries) {
		if (entry.status !== "idle" || timerIsHeld(entry.id)) continue;
		scheduleTimer(entry.id, remaining.get(entry.id) ?? UNDO_WINDOW_MS);
	}
}

/** Clears every queue and timer on an account/session change. */
export function resetUndoToasts() {
	for (const id of [...timers.keys()]) clearTimer(id);
	clearQueueExpiry();
	entries = [];
	queued = [];
	announcements = [];
	pauseReasons.clear();
	remaining.clear();
	emit();
}

/** Test-only reset; production keeps ids monotonic so late responses cannot hit a reused id. */
export function resetUndoToastsForTests() {
	resetUndoToasts();
	nextId = 0;
	nextAnnouncementId = 0;
	pageHidden = false;
	globalPauseReasons.clear();
}

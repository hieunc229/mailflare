"use client";

import type { MessageActionRecord, ReversibleMessageAction } from "./types";

export type UndoToastStatus = "idle" | "undoing" | "failed";

export type UndoToastEntry = {
	id: number;
	action: ReversibleMessageAction;
	records: MessageActionRecord[];
	undoToken: string;
	skipped: number;
	status: UndoToastStatus;
};

const UNDO_WINDOW_MS = 9000;
const FAILED_WINDOW_MS = 5000;
const MAX_TOASTS = 4;

let entries: UndoToastEntry[] = [];
let nextId = 0;
const timers = new Map<number, number>();
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

function setTimer(id: number, delay: number) {
	if (typeof window === "undefined") return;
	const existing = timers.get(id);
	if (existing) window.clearTimeout(existing);
	timers.set(id, window.setTimeout(() => {
		timers.delete(id);
		dismissUndoToast(id);
	}, delay));
}

function clearTimer(id: number) {
	if (typeof window === "undefined") return;
	const timer = timers.get(id);
	if (timer) window.clearTimeout(timer);
	timers.delete(id);
}

export function subscribeUndoToasts(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getUndoToasts(): UndoToastEntry[] {
	return entries;
}

/** Adds an independent toast; compose's single send notice is never touched. */
export function showUndoToast(input: {
	action: ReversibleMessageAction;
	records: MessageActionRecord[];
	undoToken?: string;
	skipped?: number;
}): number | null {
	if (!input.undoToken || input.records.length === 0 || typeof window === "undefined") return null;
	const id = ++nextId;
	entries = [
		...entries.slice(-(MAX_TOASTS - 1)),
		{
			id,
			action: input.action,
			records: input.records,
			undoToken: input.undoToken,
			skipped: input.skipped ?? 0,
			status: "idle",
		},
	];
	setTimer(id, UNDO_WINDOW_MS);
	emit();
	return id;
}

export function beginUndoToast(id: number) {
	clearTimer(id);
	entries = entries.map((entry) => (entry.id === id ? { ...entry, status: "undoing" } : entry));
	emit();
}

export function failUndoToast(id: number) {
	entries = entries.map((entry) => (entry.id === id ? { ...entry, status: "failed" } : entry));
	setTimer(id, FAILED_WINDOW_MS);
	emit();
}

export function dismissUndoToast(id: number) {
	clearTimer(id);
	entries = entries.filter((entry) => entry.id !== id);
	emit();
}

/** Test-only reset; the provider never calls this. */
export function resetUndoToastsForTests() {
	for (const id of timers.keys()) clearTimer(id);
	entries = [];
	nextId = 0;
	emit();
}

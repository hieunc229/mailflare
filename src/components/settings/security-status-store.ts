"use client";

import { useEffect, useSyncExternalStore } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import type { SecurityStatus } from "./passkey-settings-types";

type Snapshot = {
	status: SecurityStatus | null;
	error: boolean;
	loading: boolean;
};

const EMPTY: Snapshot = { status: null, error: false, loading: false };
let snapshot: Snapshot = EMPTY;
let inflight: Promise<void> | null = null;
let inflightGeneration = 0;
let generation = 0;
const listeners = new Set<() => void>();
let listening = false;

function emit() {
	for (const listener of listeners) listener();
}

function setSnapshot(next: Snapshot) {
	snapshot = next;
	emit();
}

/**
 * One shared snapshot keeps every Security card in step after any change.
 * `force` waits for an in-flight read and then starts a fresh one, so a focus
 * refresh that began before a mutation cannot be mistaken for its result.
 */
export async function refreshSecurityStatus(force = false): Promise<void> {
	if (inflight) {
		if (!force) return inflight;
		// A pending request from an older account generation is not a reason to
		// wait; drop it and start the new one immediately.
		if (inflightGeneration === generation) await inflight;
		else inflight = null;
	}
	setSnapshot({ ...snapshot, loading: true, error: false });
	const requestGeneration = generation;
	const request = (async () => {
		try {
			const res = await authFetch("/api/settings/security");
			const data = (await res.json()) as SecurityStatus;
			if (!res.ok) throw new Error("security-status");
			// A response for the previous account must never repaint the cards.
			if (requestGeneration === generation) setSnapshot({ status: data, error: false, loading: false });
		} catch {
			if (requestGeneration === generation) setSnapshot({ ...snapshot, error: true, loading: false });
		} finally {
			// Do not let an old request clear a newer one's slot.
			if (inflightGeneration === requestGeneration) {
				inflight = null;
				inflightGeneration = 0;
			}
		}
	})();
	inflight = request;
	inflightGeneration = requestGeneration;
	return request;
}

function invalidateForSessionChange() {
	generation++;
	snapshot = EMPTY;
	// Abandon the previous account's request so the next mount fetches.
	inflight = null;
	inflightGeneration = 0;
	setSnapshot(EMPTY);
	void refreshSecurityStatus();
}

function onWindowActivity() {
	void refreshSecurityStatus();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!listening && typeof window !== "undefined") {
		listening = true;
		window.addEventListener("mailflare:security-changed", onWindowActivity);
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, invalidateForSessionChange);
		window.addEventListener("focus", onWindowActivity);
		document.addEventListener("visibilitychange", onWindowActivity);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && listening) {
			listening = false;
			generation++;
			snapshot = EMPTY;
			// An in-flight read belongs to the page that just unmounted. The
			// next mount must not wait for it or discard its own fetch.
			inflight = null;
			inflightGeneration = 0;
			window.removeEventListener("mailflare:security-changed", onWindowActivity);
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, invalidateForSessionChange);
			window.removeEventListener("focus", onWindowActivity);
			document.removeEventListener("visibilitychange", onWindowActivity);
		}
	};
}

export function useSecurityStatus() {
	const current = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
	useEffect(() => {
		if (!current.status && !inflight) void refreshSecurityStatus();
	}, [current.status]);
	return current;
}

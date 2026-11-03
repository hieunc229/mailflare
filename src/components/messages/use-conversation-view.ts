"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "mailflare-conversation-view";
const CHANGE_EVENT = "mailflare:conversation-view-changed";

function readStored(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

function subscribe(onStoreChange: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, onStoreChange);
	window.addEventListener("storage", onStoreChange);
	return () => {
		window.removeEventListener(CHANGE_EVENT, onStoreChange);
		window.removeEventListener("storage", onStoreChange);
	};
}

function getServerSnapshot(): boolean {
	return true;
}

/**
 * Whether lists collapse each conversation to one row. On by default and
 * remembered per browser; every open list follows a change immediately.
 */
export function useConversationView(): [boolean, (next: boolean) => void] {
	const enabled = useSyncExternalStore(subscribe, readStored, getServerSnapshot);

	const update = useCallback((next: boolean) => {
		try {
			localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
		} catch {
			// Private mode or blocked storage: the toggle still applies for this page.
		}
		window.dispatchEvent(new Event(CHANGE_EVENT));
	}, []);

	return [enabled, update];
}

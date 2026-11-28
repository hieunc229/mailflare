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

/**
 * A boolean preference kept in localStorage, readable on the first client render and shared by every
 * mounted user. `read` keeps each preference's own default; `serverValue` is what the server renders.
 */
export function createLocalPref(options: { key: string; changeEvent: string; read: () => boolean; serverValue: boolean }): () => [boolean, (next: boolean) => void] {
	// Set only while storage refuses writes, so the toggle still applies for this page.
	let unsaved: boolean | undefined;
	const subscribe = (onStoreChange: () => void) => {
		window.addEventListener(options.changeEvent, onStoreChange);
		window.addEventListener("storage", onStoreChange);
		return () => {
			window.removeEventListener(options.changeEvent, onStoreChange);
			window.removeEventListener("storage", onStoreChange);
		};
	};
	const getSnapshot = () => unsaved ?? options.read();
	const getServerSnapshot = () => options.serverValue;
	const update = (next: boolean) => {
		try {
			localStorage.setItem(options.key, next ? "on" : "off");
			unsaved = undefined;
		} catch {
			unsaved = next;
		}
		window.dispatchEvent(new Event(options.changeEvent));
	};
	return () => [useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot), update];
}

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "mailflare-auto-advance";
const CHANGE_EVENT = "mailflare:auto-advance-changed";

function readStored(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "on";
	} catch {
		return false;
	}
}

/** Whether archiving or deleting an open message opens the next one instead of the list. Off by default. */
export function useAutoAdvanceEnabled(): [boolean, (next: boolean) => void] {
	const [enabled, setEnabled] = useState(false);

	useEffect(() => {
		const sync = () => setEnabled(readStored());
		sync();
		window.addEventListener(CHANGE_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(CHANGE_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);

	const update = useCallback((next: boolean) => {
		try {
			localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
		} catch {
			// Private mode or blocked storage: the toggle still applies for this page.
		}
		setEnabled(next);
		window.dispatchEvent(new Event(CHANGE_EVENT));
	}, []);

	return [enabled, update];
}

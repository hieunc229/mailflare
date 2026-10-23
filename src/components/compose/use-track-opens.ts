import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "mailflare-track-opens";
const CHANGE_EVENT = "mailflare:track-opens-changed";

function readStored(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "on";
	} catch {
		return false;
	}
}

/**
 * Whether new messages carry a read-receipt pixel. Off by default and
 * remembered per browser, so the last choice applies to the next message.
 */
export function useTrackOpens(): [boolean, (next: boolean) => void] {
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

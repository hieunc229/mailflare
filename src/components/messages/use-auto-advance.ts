import { createLocalPref } from "./use-conversation-view";

const STORAGE_KEY = "mailflare-auto-advance";

function readStored(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "on";
	} catch {
		return false;
	}
}

/** Whether archiving or deleting an open message opens the next one instead of the list. Off by default. */
export const useAutoAdvanceEnabled = createLocalPref({ key: STORAGE_KEY, changeEvent: "mailflare:auto-advance-changed", read: readStored, serverValue: false });

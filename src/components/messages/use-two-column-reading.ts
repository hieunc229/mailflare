import { createLocalPref } from "./use-conversation-view";

const STORAGE_KEY = "mailflare-two-column-reading";

function readStored() {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

export const useTwoColumnReading = createLocalPref({ key: STORAGE_KEY, changeEvent: "mailflare:two-column-reading-changed", read: readStored, serverValue: true });

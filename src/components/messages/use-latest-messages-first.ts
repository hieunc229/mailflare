import { createLocalPref } from "./use-conversation-view";

const STORAGE_KEY = "mailflare-latest-messages-first";

function readStored(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

/** Whether conversations display newest to oldest. Enabled by default. */
export const useLatestMessagesFirst = createLocalPref({ key: STORAGE_KEY, changeEvent: "mailflare:latest-messages-first-changed", read: readStored, serverValue: true });

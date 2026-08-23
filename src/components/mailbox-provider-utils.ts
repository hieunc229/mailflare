import { authFetch } from "@/lib/auth/client";
import type { MailboxOption } from "./mailbox-provider";

let mailboxesCache: MailboxOption[] | null = null;
let mailboxesRequest: Promise<MailboxOption[]> | null = null;
let cacheGeneration = 0;
export const SELECTED_MAILBOX_STORAGE_KEY = "selected-mailbox-id";

export function clearMailboxesCache() {
	cacheGeneration += 1;
	mailboxesCache = null;
	mailboxesRequest = null;
}

export function clearMailboxClientState() {
	clearMailboxesCache();
	if (typeof window !== "undefined") {
		localStorage.removeItem(SELECTED_MAILBOX_STORAGE_KEY);
	}
}

export async function fetchMailboxOptions(force = false): Promise<MailboxOption[]> {
	if (!force && mailboxesCache) return mailboxesCache;
	if (!force && mailboxesRequest) return mailboxesRequest;

	const requestGeneration = cacheGeneration;
	mailboxesRequest = authFetch("/api/mailboxes")
		.then((res) => res.json())
		.then((data) => {
			const items = ((data as { mailboxes?: MailboxOption[] }).mailboxes ?? []).map((m) => ({
				id: m.id,
				localPart: m.localPart,
				hostname: m.hostname,
				displayName: m.displayName,
				forwardTo: m.forwardTo,
				type: m.type,
				permission: m.permission,
				isPrimary: m.isPrimary,
			}));
			if (requestGeneration === cacheGeneration) mailboxesCache = items;
			return items;
		})
		.finally(() => {
			if (requestGeneration === cacheGeneration) mailboxesRequest = null;
		});

	return mailboxesRequest;
}

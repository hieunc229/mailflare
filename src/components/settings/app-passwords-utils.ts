import { authFetch } from "@/lib/auth/client";
import { requestError } from "@/lib/http/client-error";
import type { AppPasswordList, CreatedAppPassword, NewAppPassword } from "./app-passwords-types";

/** "abcdefghijklmnop" becomes "abcd efgh ijkl mnop", easier to type on a phone. The server ignores the spaces. */
export function groupAppPassword(password: string): string {
	return password.replace(/(.{4})(?=.)/g, "$1 ");
}

const PROTOCOL_NAMES: Record<string, string> = { jmap: "JMAP", caldav: "CalDAV", carddav: "CardDAV", imap: "IMAP", submission: "SMTP" };

/** Protocol names are technical terms, so they are not translated. */
export function appPasswordProtocolName(protocol: string): string {
	return PROTOCOL_NAMES[protocol] ?? protocol;
}

export async function loadAppPasswords(): Promise<AppPasswordList> {
	const res = await authFetch("/api/app-passwords");
	const data = (await res.json().catch(() => ({}))) as Partial<AppPasswordList> & { error?: unknown };
	if (!res.ok || !data.appPasswords || !data.availableProtocols) throw requestError(data, "Could not load app passwords");
	return { appPasswords: data.appPasswords, availableProtocols: data.availableProtocols };
}

/** `stepUpToken` comes from the confirmation dialog; a 401 here means that proof was refused, not that the session ended. */
export async function createAppPassword(input: NewAppPassword, stepUpToken: string): Promise<CreatedAppPassword> {
	const res = await authFetch("/api/app-passwords", {
		method: "POST",
		redirectOnUnauthorized: false,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...input, stepUpToken }),
	});
	const data = (await res.json().catch(() => ({}))) as Partial<CreatedAppPassword> & { error?: unknown; code?: unknown };
	if (!res.ok || !data.key || !data.id) throw requestError(data, "Could not create the app password");
	return { id: data.id, key: data.key, name: input.name, protocols: data.protocols ?? input.protocols, mailboxIds: data.mailboxIds ?? input.mailboxIds };
}

export async function revokeAppPassword(id: string): Promise<void> {
	const res = await authFetch(`/api/app-passwords/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!res.ok) throw requestError((await res.json().catch(() => ({}))) as { error?: unknown }, "Could not revoke the app password");
}

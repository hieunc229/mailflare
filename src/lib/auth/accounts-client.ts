"use client";

import { authFetch, setClientSessionToken } from "@/lib/auth/client";

export type BrowserAccount = {
	userId: string;
	email: string;
	name: string;
	hasAvatar: boolean;
	active: boolean;
};

export async function fetchBrowserAccounts(): Promise<BrowserAccount[]> {
	try {
		const res = await authFetch("/api/auth/accounts", { redirectOnUnauthorized: false, cache: "no-store" });
		if (!res.ok) return [];
		return ((await res.json()) as { accounts: BrowserAccount[] }).accounts;
	} catch {
		return [];
	}
}

/** Returns an error message, or null once the switch succeeded. */
export async function switchBrowserAccount(userId: string): Promise<string | null> {
	const res = await authFetch("/api/auth/switch", {
		method: "POST",
		redirectOnUnauthorized: false,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ userId }),
	});
	const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
	if (!res.ok || !data.token) return data.error ?? "Could not switch account";
	setClientSessionToken(data.token);
	return null;
}

/** Returns an error message, or null once the account was removed from this browser. */
export async function signOutBrowserAccount(userId: string): Promise<string | null> {
	const res = await authFetch("/api/auth/accounts", {
		method: "DELETE",
		redirectOnUnauthorized: false,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ userId }),
	});
	if (res.ok) return null;
	return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not remove account";
}

"use client";

import { AUTH_SESSION_CHANGED_EVENT, authFetch, getClientSessionToken } from "@/lib/auth/client";

const CACHE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 32;
const MAX_INVALIDATION_RETRIES = 8;
const cache = new Map<string, { expiresAt: number; data: FolderListResponse }>();
const requests = new Map<string, Promise<FolderListResponse>>();
let epoch = 0;
let sessionEpoch = 0;
let listenersInstalled = false;

export type FolderListResponse = { folders?: unknown[]; error?: string };

function invalidate(): void {
	++epoch;
	cache.clear();
	requests.clear();
}

function invalidateSession(): void {
	++sessionEpoch;
	invalidate();
}

function installInvalidationListeners(): void {
	if (listenersInstalled || typeof window === "undefined") return;
	listenersInstalled = true;
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, invalidateSession);
	window.addEventListener("mailflare:messages-changed", invalidate);
	window.addEventListener("mailflare:folders-changed", invalidate);
}

export function invalidateFolderCache(): void {
	invalidate();
}

export async function getMailboxFolders<T extends FolderListResponse = FolderListResponse>(
	mailboxId: string,
): Promise<T> {
	installInvalidationListeners();
	const sessionToken = getClientSessionToken();
	const requestSessionEpoch = sessionEpoch;
	const key = `${sessionToken ?? ""}\u0000${mailboxId}`;
	for (let retries = 0; ; retries++) {
		if (sessionEpoch !== requestSessionEpoch || sessionToken !== getClientSessionToken()) {
			throw new Error("Folder request was invalidated");
		}
		const now = Date.now();
		const cached = cache.get(key);
		if (cached && cached.expiresAt > now) {
			cache.delete(key);
			cache.set(key, cached);
			return cached.data as T;
		}
		if (cached) cache.delete(key);

		const requestEpoch = epoch;
		let request = requests.get(key);
		if (!request) {
			request = (async () => {
				const params = new URLSearchParams({ mailboxId });
				const response = await authFetch(`/api/folders?${params.toString()}`, { cache: "no-store" });
				const data = (await response.json()) as FolderListResponse;
				if (!response.ok) throw new Error(data.error ?? "Unable to load folders");
				if (requestEpoch !== epoch || sessionEpoch !== requestSessionEpoch ||
					sessionToken !== getClientSessionToken() || requests.get(key) !== request) {
					throw new Error("Folder request was invalidated");
				}
				cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
				if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
				return data;
			})();
			requests.set(key, request);
		}
		try {
			const data = await request;
			if (sessionEpoch !== requestSessionEpoch || sessionToken !== getClientSessionToken()) {
				throw new Error("Folder request was invalidated");
			}
			if (requestEpoch !== epoch) {
				if (retries >= MAX_INVALIDATION_RETRIES) throw new Error("Folder request was invalidated");
				continue;
			}
			return data as T;
		} catch (error) {
			if (sessionEpoch !== requestSessionEpoch || sessionToken !== getClientSessionToken()) {
				throw new Error("Folder request was invalidated");
			}
			if (requestEpoch === epoch || retries >= MAX_INVALIDATION_RETRIES) throw error;
		} finally {
			if (requests.get(key) === request) requests.delete(key);
		}
	}
}

"use client";

import { useEffect, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";

export type CurrentUser = {
	id: string;
	email: string;
	name: string;
	role: "admin" | "user";
	isPrimaryAdmin: boolean;
	canManageMailboxes: boolean;
	canManageDomains: boolean;
	canManageUsers: boolean;
	hasAvatar: boolean;
};

export type SessionInfo = {
	status: number;
	hasMailboxes?: boolean;
	isSetup?: boolean;
	user?: (CurrentUser & { timeZone?: string | null }) | null;
};

const SESSION_INFO_MAX_AGE_MS = 5 * 60 * 1000;

let cachedSession: { info: SessionInfo; at: number } | null = null;
let cachedUser: CurrentUser | null = null;
let inflight: Promise<SessionInfo | null> | null = null;
let userRequest: { session: Promise<SessionInfo | null>; user: Promise<CurrentUser | null> } | null = null;
let generation = 0;

export function clearCurrentUserCache(): void {
	generation += 1;
	cachedSession = null;
	cachedUser = null;
	inflight = null;
	userRequest = null;
}

if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearCurrentUserCache);

/** The cached answer if it is still fresh, without a request. */
export function peekSessionInfo(): SessionInfo | null {
	return cachedSession && Date.now() - cachedSession.at < SESSION_INFO_MAX_AGE_MS ? cachedSession.info : null;
}

async function requestSessionInfo(): Promise<SessionInfo> {
	const cookieResponse = await fetch("/api/auth/me", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
	const response = cookieResponse.ok || cookieResponse.status !== 401
		? cookieResponse
		: await authFetch("/api/auth/me", { redirectOnUnauthorized: false, signal: AbortSignal.timeout(5_000) });
	if (!response.ok) return { status: response.status };
	const data = (await response.json()) as Omit<SessionInfo, "status">;
	return { status: response.status, ...data };
}

/**
 * The `/api/auth/me` answer shared by the auth guard, sidebar and account menus,
 * so navigating does not refetch it. `fresh` bypasses the cache; network
 * failures resolve to null and are never cached.
 */
export function fetchSessionInfo({ fresh = false }: { fresh?: boolean } = {}): Promise<SessionInfo | null> {
	const cached = fresh ? null : peekSessionInfo();
	if (cached) return Promise.resolve(cached);
	if (!inflight) {
		const requestGeneration = generation;
		const request = requestSessionInfo()
			.then((info) => {
				if (requestGeneration !== generation) return null;
				cachedSession = info.status === 200 ? { info, at: Date.now() } : null;
				cachedUser = info.user ?? null;
				return info;
			})
			.catch(() => null)
			.finally(() => {
				if (inflight === request) inflight = null;
			});
		inflight = request;
	}
	return inflight;
}

export function fetchCurrentUser(): Promise<CurrentUser | null> {
	if (cachedUser) return Promise.resolve(cachedUser);
	const session = fetchSessionInfo();
	if (!userRequest || userRequest.session !== session) {
		userRequest = { session, user: session.then((info) => info?.user ?? null) };
	}
	return userRequest.user;
}

export function useCurrentUser(): CurrentUser | null {
	const [user, setUser] = useState<CurrentUser | null>(cachedUser);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		let active = true;
		const requestGeneration = generation;
		void fetchCurrentUser().then((next) => {
			if (active && requestGeneration === generation) setUser(next);
		});
		return () => {
			active = false;
		};
	}, [reloadKey]);

	// Login and logout swap the cached account without a reload, so refetch when the session changes.
	useEffect(() => {
		function onSessionChanged() {
			clearCurrentUserCache();
			setUser(null);
			setReloadKey((key) => key + 1);
		}
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
	}, []);

	return user;
}

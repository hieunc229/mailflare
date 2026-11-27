"use client";

import { getUserTimeZone } from "@/lib/time/utils";
import { clearUserTimeZonePreference } from "@/lib/time/client";
import type {
	AuthFetchOptions,
	AuthSessionChangedDetail,
	AuthSessionResponse,
} from "./client-types";

const SESSION_STORAGE_KEY = "mailflare-session-token";
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";
const MIGRATION_REQUIRED_PATH = "/migration-required.html";
let migrationRedirectPending = false;

function dispatchAuthSessionChanged(authenticated: boolean): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
			detail: { authenticated },
		}),
	);
}

export function getClientSessionToken(): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(SESSION_STORAGE_KEY);
}

export function setClientSessionToken(token: string): void {
	const previousToken = localStorage.getItem(SESSION_STORAGE_KEY);
	localStorage.setItem(SESSION_STORAGE_KEY, token);
	if (previousToken !== token) clearUserTimeZonePreference();
	if (previousToken !== token) dispatchAuthSessionChanged(true);
}

export function clearClientSessionToken(): void {
	localStorage.removeItem(SESSION_STORAGE_KEY);
	clearUserTimeZonePreference();
	dispatchAuthSessionChanged(false);
}

export function getAuthHeaders(headers?: HeadersInit): Headers {
	const nextHeaders = new Headers(headers);
	if (typeof window !== "undefined" && !nextHeaders.has("X-Time-Zone")) {
		nextHeaders.set("X-Time-Zone", getUserTimeZone());
	}
	const token = getClientSessionToken();
	if (token && !nextHeaders.has("Authorization")) {
		nextHeaders.set("Authorization", `Bearer ${token}`);
	}
	return nextHeaders;
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchOptions = {}): Promise<Response> {
	const { redirectOnUnauthorized = true, headers, ...requestInit } = init;
	const response = await fetch(input, {
		...requestInit,
		headers: getAuthHeaders(headers),
	});

	if (response.status === 401 && redirectOnUnauthorized && typeof window !== "undefined") {
		clearClientSessionToken();
		window.location.assign("/login");
	}

	// The server's digest channel can carry a status without an error body.
	// Ordinary JSON conflicts (including MIGRATION_REQUIRED) belong to callers.
	if (
		response.status === 409 &&
		typeof window !== "undefined" &&
		!migrationRedirectPending
	) {
		// Inspect a clone: headers alone cannot prove emptiness, and callers must
		// retain the original response body. An unreadable body is not empty.
		let empty = response.body === null;
		if (!empty) {
			try {
				empty = await response.clone().text() === "";
			} catch {
				// A failed inspection must not replace the caller's response.
			}
		}
		if (
			empty &&
			!migrationRedirectPending &&
			window.location.pathname !== MIGRATION_REQUIRED_PATH &&
			window.location.pathname !== "/migration-required"
		) {
			migrationRedirectPending = true;
			// This static document must bypass Next.js and database-backed layouts.
			// oxlint-disable-next-line nextjs-js/no-location-assign-relative-destination
			window.location.assign(MIGRATION_REQUIRED_PATH);
		}
	}

	return response;
}

export async function persistAuthSession(response: Response): Promise<AuthSessionResponse> {
	const data = (await response.json()) as AuthSessionResponse;
	if (response.ok && data.token) setClientSessionToken(data.token);
	return data;
}

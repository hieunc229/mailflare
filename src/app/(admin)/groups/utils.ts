import { authFetch } from "@/lib/auth/client";
import type { TranslationKey } from "@/lib/i18n/types";
import type { GroupCandidate, GroupDetailResponse, GroupsListResponse, WhoCanPost } from "./types";

export const MAX_GROUP_MEMBERS = 500;

/** A failed groups API call. `code` is the API's machine-readable reason, for the states that are not plain errors. */
export class GroupsApiError extends Error {
	constructor(message: string, readonly status: number, readonly code?: string) {
		super(message);
	}
}

export function isLicenseRequired(error: unknown): boolean {
	return error instanceof GroupsApiError && error.code === "LICENSE_REQUIRED";
}

export function isMigrationRequired(error: unknown): boolean {
	return error instanceof GroupsApiError && error.code === "MIGRATION_REQUIRED";
}

/** The API answers a string, or zod's flattened errors for a malformed body; the UI shows only readable text. */
export function readApiError(body: unknown, fallback: string): string {
	const error = (body as { error?: unknown } | null)?.error;
	return typeof error === "string" && error ? error : fallback;
}

export async function groupsFetch<T>(url: string, fallbackError: string, init?: RequestInit): Promise<T> {
	const response = await authFetch(url, init);
	const body = (await response.json().catch(() => null)) as (T & { error?: unknown; code?: string }) | null;
	if (!response.ok) throw new GroupsApiError(readApiError(body, fallbackError), response.status, body?.code);
	return body as T;
}

export function jsonInit(method: string, body?: unknown): RequestInit {
	return { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

export const fetchGroups = (fallback: string) => groupsFetch<GroupsListResponse>("/api/groups", fallback);
export const fetchGroup = (id: string, fallback: string) => groupsFetch<GroupDetailResponse>(`/api/groups/${id}`, fallback);
export const fetchCandidates = (id: string, query: string, fallback: string) =>
	groupsFetch<{ candidates: GroupCandidate[] }>(`/api/groups/${id}/candidates?q=${encodeURIComponent(query)}`, fallback);

export const WHO_CAN_POST: { value: WhoCanPost; label: TranslationKey; hint: TranslationKey; dmarcNote: boolean }[] = [
	{ value: "anyone", label: "groups.post.anyone", hint: "groups.post.anyoneHint", dmarcNote: false },
	{ value: "org", label: "groups.post.org", hint: "groups.post.orgHint", dmarcNote: true },
	{ value: "members", label: "groups.post.members", hint: "groups.post.membersHint", dmarcNote: true },
];

export function postLabel(value: WhoCanPost): TranslationKey {
	return WHO_CAN_POST.find((option) => option.value === value)!.label;
}

/** Wraps around the list so arrow keys never fall off either end. */
export function nextIndex(current: number, delta: 1 | -1, length: number): number {
	if (length === 0) return -1;
	if (current < 0) return delta === 1 ? 0 : length - 1;
	return (current + delta + length) % length;
}

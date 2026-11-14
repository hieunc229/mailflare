import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import type { InviteCardData, InviteResponse, InviteView } from "./invite-types";

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_LIMIT = 100;

type CacheEntry = { data: InviteCardData | null; expiresAt: number };

const inviteCache = new Map<string, CacheEntry>();
const inviteRequests = new Map<string, Promise<InviteCardData | null>>();
let generation = 0;
let dataVersion = 0;

/** A found invitation, a cached "no invitation" (null), or undefined when this message was never checked. */
export function getCachedInviteCard(messageId: string): InviteCardData | null | undefined {
	const cached = inviteCache.get(messageId);
	if (!cached) return undefined;
	if (cached.expiresAt <= Date.now()) {
		inviteCache.delete(messageId);
		return undefined;
	}
	inviteCache.delete(messageId);
	inviteCache.set(messageId, cached);
	return cached.data;
}

export function cacheInviteCard(messageId: string, data: InviteCardData | null): void {
	inviteCache.delete(messageId);
	inviteCache.set(messageId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
	if (inviteCache.size > CACHE_LIMIT) {
		const oldest = inviteCache.keys().next().value;
		if (oldest) inviteCache.delete(oldest);
	}
}

export function clearInviteCache(): void {
	generation += 1;
	inviteCache.clear();
	inviteRequests.clear();
}

/**
 * After an answer, another message about the same event (a cancellation or update) may
 * point at a different calendar row. Drop the rest so those cards refetch on open. Pending
 * requests are left running: their cards keep rendering, and a result from before this
 * change is returned but not cached, so the next open fetches the current state.
 */
export function cacheAnsweredInvite(messageId: string, data: InviteCardData): void {
	dataVersion += 1;
	inviteCache.clear();
	// Cards that already asked keep their promises; a card opened after the answer starts fresh.
	inviteRequests.clear();
	cacheInviteCard(messageId, data);
}

/**
 * The invitation for one message. A cached answer, including "no invitation", is reused;
 * concurrent callers share one request so a click prefetch and the card do not race.
 */
export function fetchInviteCard(messageId: string): Promise<InviteCardData | null> {
	const cached = getCachedInviteCard(messageId);
	if (cached !== undefined) return Promise.resolve(cached);
	const pending = inviteRequests.get(messageId);
	if (pending) return pending;

	const requestGeneration = generation;
	const requestVersion = dataVersion;
	const request = authFetch(`/api/messages/${messageId}/invite`, { cache: "no-store" })
		.then(async (response) => {
			if (requestGeneration !== generation) throw new Error("Invitation request invalidated");
			const body = await response.json().catch(() => ({})) as {
				invite?: InviteView | null;
				eventId?: string | null;
				response?: InviteResponse | null;
				canRespond?: boolean;
				error?: string;
			};
			// The session can change while the body is being read, after the check above.
			if (requestGeneration !== generation) throw new Error("Invitation request invalidated");
			// An answer landed while this request was in flight: show it to the card that asked,
			// but leave the cache empty so the next open reads the post-answer calendar state.
			const cacheResult = requestVersion === dataVersion;
			if (response.ok) {
				const data = body.invite
					? { invite: body.invite, eventId: body.eventId ?? null, response: body.response ?? null, canRespond: !!body.canRespond }
					: null;
				if (cacheResult) cacheInviteCard(messageId, data);
				return data;
			}
			// Unreadable or absent invitations are stable enough to remember; other failures retry.
			if (response.status === 404 || response.status === 422) {
				if (cacheResult) cacheInviteCard(messageId, null);
				return null;
			}
			throw new Error(body.error ?? "Invitation could not be loaded");
		})
		.finally(() => {
			if (inviteRequests.get(messageId) === request) inviteRequests.delete(messageId);
		});

	inviteRequests.set(messageId, request);
	return request;
}

if (typeof window !== "undefined") {
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearInviteCache);
}

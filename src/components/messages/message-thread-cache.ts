import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { getMessagesChangedDetail } from "@/lib/messages/change-events";
import {
	applyPendingToMessages,
	rememberMessageFields,
	rememberMessageRows,
} from "@/lib/messages/field-store";
import { rememberMembershipRows } from "@/lib/messages/membership-store";
import type { ThreadMessage, ThreadResponse } from "@/hooks/types";

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 20;
const MAX_CACHED_MESSAGES = 50;
const MAX_CACHED_BODY_CHARS = 2_000_000;

// Key by anchor message: thread ids are shared across mailboxes.
const threadCache = new Map<string, { messages: ThreadMessage[]; expiresAt: number }>();
const threadRequests = new Map<string, Promise<ThreadMessage[]>>();
let generation = 0;

export class MessageThreadInvalidatedError extends Error {
	constructor() {
		super("Message thread request invalidated");
		this.name = "MessageThreadInvalidatedError";
	}
}

export function isMessageThreadInvalidated(error: unknown): boolean {
	return error instanceof MessageThreadInvalidatedError;
}

function bodyChars(messages: ThreadMessage[]): number {
	return messages.reduce((total, message) => total + (message.textBody?.length ?? 0) + (message.htmlBody?.length ?? 0), 0);
}

function cacheThread(messageId: string, messages: ThreadMessage[]): void {
	if (messages.length > MAX_CACHED_MESSAGES || bodyChars(messages) > MAX_CACHED_BODY_CHARS) return;
	const pendingMessages = applyPendingToMessages(messages);
	threadCache.delete(messageId);
	threadCache.set(messageId, { messages: pendingMessages, expiresAt: Date.now() + CACHE_TTL_MS });
	rememberMessageRows(pendingMessages);
	rememberMembershipRows(pendingMessages);
	if (threadCache.size > CACHE_LIMIT) {
		const oldest = threadCache.keys().next().value;
		if (oldest) threadCache.delete(oldest);
	}
}

export function getCachedMessageThread(messageId: string | null | undefined): ThreadMessage[] | undefined {
	if (!messageId) return undefined;
	const cached = threadCache.get(messageId);
	if (!cached) return undefined;
	if (cached.expiresAt <= Date.now()) {
		threadCache.delete(messageId);
		return undefined;
	}
	threadCache.delete(messageId);
	threadCache.set(messageId, cached);
	return applyPendingToMessages(cached.messages);
}

export function fetchMessageThread(messageId: string): Promise<ThreadMessage[]> {
	const cached = getCachedMessageThread(messageId);
	if (cached) return Promise.resolve(cached);
	const pending = threadRequests.get(messageId);
	if (pending) return pending;

	const requestGeneration = generation;
	const request = authFetch(`/api/messages/${messageId}/thread`)
		.then(async (response) => {
			if (!response.ok) return [];
			const data = await response.json() as ThreadResponse;
			if (requestGeneration !== generation) throw new MessageThreadInvalidatedError();
			const messages = data.messages ?? [];
			cacheThread(messageId, messages);
			return applyPendingToMessages(messages);
		})
		.finally(() => {
			if (threadRequests.get(messageId) === request) threadRequests.delete(messageId);
		});
	threadRequests.set(messageId, request);
	return request;
}

export function patchMessageThreadFieldsInCaches(
	messageIds: string[],
	patch: { read?: boolean; starred?: boolean },
): void {
	if (messageIds.length === 0) return;
	const ids = new Set(messageIds);
	// An in-flight request may predate this patch; drop it rather than cache stale fields.
	generation += 1;
	threadRequests.clear();
	for (const [messageId, cached] of threadCache) {
		if (!cached.messages.some((message) => ids.has(message.id))) continue;
		const messages = applyPendingToMessages(cached.messages.map((message) => (
			ids.has(message.id) ? { ...message, ...patch } : message
		)));
		threadCache.set(messageId, { ...cached, messages });
		rememberMessageRows(messages);
		rememberMembershipRows(messages);
	}
	rememberMessageFields(messageIds, patch);
}

export function markMessageThreadReadInCaches(messageIds: string[], read: boolean): void {
	patchMessageThreadFieldsInCaches(messageIds, { read });
}

/** Drops in-flight thread requests while keeping an already-patched cache. */
export function invalidateMessageThreadRequests(): void {
	generation += 1;
	threadRequests.clear();
}

export function clearMessageThreadCache(): void {
	generation += 1;
	threadCache.clear();
	threadRequests.clear();
}

if (typeof window !== "undefined") {
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearMessageThreadCache);
	window.addEventListener("mailflare:messages-changed", (event) => {
		const detail = getMessagesChangedDetail(event);
		if (!detail?.kind) {
			clearMessageThreadCache();
			return;
		}
		if (detail.kind === "read") {
			if (detail.messageIds?.length) markMessageThreadReadInCaches(detail.messageIds, detail.read !== false);
			return;
		}
		for (const patch of detail.patches ?? []) {
			patchMessageThreadFieldsInCaches([patch.id], {
				...(patch.read !== undefined ? { read: patch.read } : {}),
				...(patch.starred !== undefined ? { starred: patch.starred } : {}),
			});
		}
	});
}

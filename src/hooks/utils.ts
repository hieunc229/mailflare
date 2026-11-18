import { authFetch } from "@/lib/auth/client";
import { parseSearchQuery } from "@/lib/search/query-utils";
import { getUserTimeZone } from "@/lib/time/utils";
import { patchCachedMessage } from "@/lib/messages/detail-cache";
import {
	applyPendingToMessageList,
	applyPendingToMessages,
	getThreadUnreadTargets,
	rememberMessageRows,
	type ThreadUnreadTarget,
} from "@/lib/messages/field-store";
import { isReadOnlyChange, type MessageFieldPatch } from "@/lib/messages/change-events";
import type { MessageFilterOptions, MessageFolder } from "./types";
import type { MessageCounts, MessageListResponse } from "./types";

/**
 * The search string goes to the server whole; operators are parsed there
 * against the full-text index. Only the read state is lifted out here so the
 * unread toggle and `is:unread` share one `read` parameter.
 */
export function parseMessageSearchQuery(query: string): MessageFilterOptions {
	const parsed = parseSearchQuery(query);
	const filters: MessageFilterOptions = {};
	if (parsed.read) filters.read = parsed.read;
	const remaining = query.replace(/(^|\s)(is:(un)?read|:(un)?read)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
	if (remaining) filters.query = remaining;
	return filters;
}

export function getMessageQueryParams(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
	folderId?: string | null,
) {
	const params = new URLSearchParams();
	params.set("timeZone", getUserTimeZone());

	if (folder === "inbox") {
		params.set("direction", "inbound");
		params.set("status", "received");
	}
	if (folder === "starred") params.set("starred", "true");
	if (folder === "snoozed") params.set("snoozed", "true");

	if (folder === "sent") {
		params.set("direction", "outbound");
		params.set("status", "sent");
	}

	if (folder === "scheduled") {
		params.set("direction", "outbound");
		params.set("scheduled", "true");
	}

	if (folder === "drafts") {
		params.set("direction", "outbound");
		params.set("status", "draft");
	}

	if (folder === "archived" || folder === "trash" || folder === "spam") {
		params.set("status", folder);
	}

	if (folderId) params.set("folderId", folderId);
	if (mailboxId) params.set("mailboxId", mailboxId);
	const searchFilters = filters?.query ? parseMessageSearchQuery(filters.query) : null;
	const parsedFilters = searchFilters
		? { ...filters, ...searchFilters, read: filters?.read ?? searchFilters.read }
		: filters;
	if (parsedFilters?.query?.trim()) params.set("q", parsedFilters.query.trim());
	if (parsedFilters?.title?.trim()) params.set("title", parsedFilters.title.trim());
	if (parsedFilters?.read && parsedFilters.read !== "all") params.set("read", parsedFilters.read);
	if (filters?.limit) params.set("limit", String(filters.limit));
	if (filters?.offset) params.set("offset", String(filters.offset));
	if (filters?.group) params.set("group", filters.group);

	return params;
}

const messageCountsCache = new Map<string, MessageCounts>();
const messageCountsRequests = new Map<string, Promise<MessageCounts | undefined>>();
const messageListCache = new Map<string, MessageListResponse>();
const messageListRequests = new Map<string, Promise<MessageListResponse>>();
let messageCacheGeneration = 0;
let messageCountsGeneration = 0;

export function clearMessageCountsCache() {
	messageCountsGeneration += 1;
	messageCountsCache.clear();
	messageCountsRequests.clear();
}

export function clearMessageListCache() {
	messageCacheGeneration += 1;
	messageListCache.clear();
	messageListRequests.clear();
}

/** Drops in-flight list requests without throwing away already-patched cached pages. */
export function invalidateMessageListRequests() {
	messageCacheGeneration += 1;
	messageListRequests.clear();
}

export type CachedMessagePatch = {
	read?: boolean;
	starred?: boolean;
};

export type MessageCachePatchOptions = {
	/** Pre-click grouped targets used when rolling back a failed/skipped undo. */
	threadTargets?: Iterable<ThreadUnreadTarget>;
};

function groupFieldPatches(fields: MessageFieldPatch[]): Map<string, CachedMessagePatch> {
	const patches = new Map<string, CachedMessagePatch>();
	for (const field of fields) {
		if (field.read === undefined && field.starred === undefined) continue;
		const current = patches.get(field.id) ?? {};
		if (field.read !== undefined) current.read = field.read;
		if (field.starred !== undefined) current.starred = field.starred;
		patches.set(field.id, current);
	}
	return patches;
}

/**
 * Mirrors field changes into every cached list page and detail. Grouped rows
 * receive an absolute unread target computed from actual member transitions,
 * so applying the same desired value twice cannot move the count twice.
 */
export function patchMessageFieldsInCaches(
	fields: MessageFieldPatch[],
	options: MessageCachePatchOptions = {},
): ThreadUnreadTarget[] {
	const patches = groupFieldPatches(fields);
	const computedTargets = patches.size === 0
		? []
		: getThreadUnreadTargets([...patches].map(([id, patch]) => ({
			id,
			...(patch.read !== undefined ? { read: patch.read } : {}),
		})));
	const forcedTargets = options.threadTargets
		? new Map([...options.threadTargets].map((target) => [target.id, target.threadUnread]))
		: null;
	const targets = computedTargets.map((target) => ({
		id: target.id,
		threadUnread: Math.max(0, Math.trunc(forcedTargets?.get(target.id) ?? target.threadUnread)),
	}));
	if (forcedTargets) {
		for (const [id, threadUnread] of forcedTargets) {
			if (!targets.some((target) => target.id === id)) {
				targets.push({ id, threadUnread: Math.max(0, Math.trunc(threadUnread)) });
			}
		}
	}
	if (patches.size === 0 && targets.length === 0) return [];
	const targetsById = new Map(targets.map((target) => [target.id, target.threadUnread]));
	const ids = new Set(patches.keys());
	invalidateMessageListRequests();
	for (const [key, response] of messageListCache) {
		if (!response.messages?.some((message) => patches.has(message.id)
			|| message.threadMessageIds?.some((id) => ids.has(id))
			|| targetsById.has(message.id))) continue;
		const messages = response.messages.map((message) => {
			const direct = patches.get(message.id);
			if (message.threadMessageIds?.length) {
				const threadTarget = targetsById.get(message.id);
				const memberPatch = message.threadMessageIds
					.map((id) => patches.get(id))
					.find((patch): patch is CachedMessagePatch => !!patch);
				const next = { ...message };
				let changed = false;
				if (threadTarget !== undefined) {
					const threadUnread = Math.min(message.threadMessageIds.length, threadTarget);
					if (next.threadUnread !== threadUnread) {
						next.threadUnread = threadUnread;
						changed = true;
					}
					const read = threadUnread === 0;
					if (next.read !== read) {
						next.read = read;
						changed = true;
					}
				}
				const starred = direct?.starred ?? memberPatch?.starred;
				if (starred !== undefined && next.starred !== starred) {
					next.starred = starred;
					changed = true;
				}
				return changed ? next : message;
			}
			if (!direct) return message;
			const next = { ...message, ...direct };
			return next.read === message.read && next.starred === message.starred ? message : next;
		});
		// A refresh during a pending undo must not see the server's pre-undo value.
		const pendingMessages = applyPendingToMessages(messages);
		messageListCache.set(key, { ...response, messages: pendingMessages });
		rememberMessageRows(pendingMessages);
	}
	for (const [id, patch] of patches) patchCachedMessage(id, patch);
	return targets;
}

export function markMessagesReadInCaches(messageIds: string[], read: boolean) {
	patchMessageFieldsInCaches(messageIds.map((id) => ({ id, read })));
}

// Caches must drop on every change, including ones made while no list is mounted
// (e.g. reading a message from the popup on a page without the inbox list).
if (typeof window !== "undefined") {
	window.addEventListener("mailflare:messages-changed", (event) => {
		if (!isReadOnlyChange(event)) clearMessageListCache();
		clearMessageCountsCache();
	});
}

export function clearMessageClientState() {
	messageCacheGeneration += 1;
	messageCountsGeneration += 1;
	messageCountsCache.clear();
	messageCountsRequests.clear();
	messageListCache.clear();
	messageListRequests.clear();
}

export async function fetchMessageCounts(mailboxId?: string | null, force = false): Promise<MessageCounts | undefined> {
	const key = mailboxId ?? "all";
	if (!force && messageCountsCache.has(key)) return messageCountsCache.get(key);
	if (!force && messageCountsRequests.has(key)) return messageCountsRequests.get(key);

	const requestGeneration = messageCacheGeneration;
	const countsGeneration = messageCountsGeneration;
	const request = (async () => {
		const params = new URLSearchParams();
		if (mailboxId) params.set("mailboxId", mailboxId);
		const query = params.toString();
		const res = await authFetch(`/api/messages/counts${query ? `?${query}` : ""}`);
		if (!res.ok) throw new Error(`Message counts request failed (${res.status})`);
		const data = (await res.json()) as { counts?: MessageCounts };
		const counts = data.counts;
		if (
			counts &&
			requestGeneration === messageCacheGeneration &&
			countsGeneration === messageCountsGeneration
		) {
			messageCountsCache.set(key, counts);
		}
		return counts;
	})().finally(() => {
		if (messageCountsRequests.get(key) === request) {
			messageCountsRequests.delete(key);
		}
	});

	messageCountsRequests.set(key, request);
	return request;
}

export function peekMessageList(params: URLSearchParams): MessageListResponse | undefined {
	const response = messageListCache.get(params.toString());
	return response ? applyPendingToMessageList(response) : undefined;
}

export async function fetchMessageList(params: URLSearchParams, force = false): Promise<MessageListResponse> {
	const key = params.toString();
	if (!force && messageListCache.has(key)) {
		return applyPendingToMessageList(messageListCache.get(key) ?? {});
	}
	if (!force && messageListRequests.has(key)) return messageListRequests.get(key) ?? {};
	const requestGeneration = messageCacheGeneration;
	const request = authFetch(`/api/messages?${key}`)
		.then(async (res) => {
			// An error body is not a message list; do not cache it or paint it as an empty folder.
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Message list request failed (${res.status})`);
			}
			return res.json();
		})
		.then((data) => {
			// Overlay before the response reaches state or cache, so a refresh that
			// started while an undo is pending cannot repaint the server value.
			const response = applyPendingToMessageList(data as MessageListResponse);
			if (requestGeneration === messageCacheGeneration) {
				messageListCache.set(key, response);
				rememberMessageRows(response.messages ?? []);
			}
			return response;
		})
		.finally(() => {
			if (requestGeneration === messageCacheGeneration) {
				messageListRequests.delete(key);
			}
		});

	messageListRequests.set(key, request);
	return request;
}

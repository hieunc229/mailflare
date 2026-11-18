import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Message, MessageFilterOptions, MessageFolder } from "./types";
import { getMessageActionPatch } from "@/lib/messages/actions/definitions";
import type { MessagesChangedDetail } from "@/lib/messages/change-events";
import { applyPendingToMessages, getKnownThreadUnread, subscribePendingOverlay } from "@/lib/messages/field-store";
import type { ThreadUnreadTarget } from "@/lib/messages/field-store";
import { registerMessageRefresh } from "./message-refresh";
import { getRestoredRowsForList, rememberRemovedRow, updateRemovedRows, type RestoredRow } from "@/lib/messages/membership-store";
import { getListMembershipKey, messageMatchesFolder, type MessageMembershipFields } from "@/lib/messages/list-membership";
import {
	clearMessageCountsCache,
	clearMessageListCache,
	fetchMessageList,
	getMessageQueryParams,
	peekMessageList,
} from "./utils";

const REFRESH_DEBOUNCE_MS = 150;

/** Actions whose server applicability depends on direction, not the list row alone. */
const DIRECTION_DEPENDENT_ACTIONS = new Set(["spam", "snooze"]);

function clampThreadUnread(value: number, size: number): number {
	return Math.min(size, Math.max(0, Math.trunc(value)));
}

/**
 * Grouped rows use an absolute aggregate. Prefer the event target or the shared
 * store; otherwise change only members that can still flip.
 */
function patchThreadRow(
	message: Message,
	ids: Set<string>,
	read: boolean,
	explicitTarget: number | undefined,
): Message {
	if (!message.threadMessageIds?.length) {
		return ids.has(message.id) ? { ...message, read } : message;
	}
	const size = message.threadMessageIds.length;
	const current = clampThreadUnread(message.threadUnread ?? 0, size);
	const target = explicitTarget ?? getKnownThreadUnread(message.id) ?? (() => {
		const flipped = message.threadMessageIds.reduce((total, id) => total + (ids.has(id) ? 1 : 0), 0);
		const possible = read ? current : size - current;
		return current + (read ? -Math.min(flipped, possible) : Math.min(flipped, possible));
	})();
	const threadUnread = clampThreadUnread(target, size);
	const nextRead = threadUnread === 0;
	if (message.threadUnread === threadUnread && message.read === nextRead) return message;
	return { ...message, read: nextRead, threadUnread };
}

type MessageListState = {
	messages: Message[];
	total: number;
	limit: number;
	offset: number;
};

type MessageListAction =
	| { type: "loaded"; messages: Message[]; total: number; limit: number; offset: number }
	| { type: "update"; updater: (messages: Message[]) => Message[] }
	| { type: "removed"; ids: Set<string> }
	| { type: "restored"; rows: RestoredRow[] };

function identityOf(message: Pick<Message, "id" | "threadId" | "threadMessageIds">): string {
	// Ungrouped lists can show several messages from one thread as separate rows.
	return message.threadMessageIds?.length && message.threadId ? `thread:${message.threadId}` : `id:${message.id}`;
}

/**
 * Drop removed ids from a row. A conversation row stays while it still has
 * members; keeping the surviving ids means a second removal can finish it.
 * The row keeps its representative id and header until the refetch, so a
 * partial removal cannot prime the detail cache with another member's header.
 */
function withoutRemovedIds(message: Message, ids: Set<string>): Message | null {
	const rowIds = message.threadMessageIds?.length ? message.threadMessageIds : [message.id];
	const remaining = rowIds.filter((id) => !ids.has(id));
	if (remaining.length === rowIds.length) return message;
	if (remaining.length === 0) return null;
	if (!message.threadMessageIds?.length) return null;
	return { ...message, threadMessageIds: remaining };
}

function messageListReducer(state: MessageListState, action: MessageListAction): MessageListState {
	if (action.type === "loaded") {
		return { messages: action.messages, total: action.total, limit: action.limit, offset: action.offset };
	}
	if (action.type === "update") {
		return { ...state, messages: action.updater(state.messages) };
	}
	if (action.type === "restored") {
		const messages = [...state.messages];
		let added = 0;
		for (const entry of action.rows) {
			const identity = identityOf(entry.row);
			const existing = messages.findIndex((message) => identityOf(message) === identity);
			if (existing >= 0) {
				const current = messages[existing];
				if (!current.threadMessageIds?.length || !entry.row.threadMessageIds?.length) continue;
				const missing = entry.row.threadMessageIds.filter((id) => !current.threadMessageIds?.includes(id));
				if (missing.length === 0) continue;
				messages[existing] = {
					...current,
					threadMessageIds: [...current.threadMessageIds, ...missing],
					threadCount: (current.threadCount ?? current.threadMessageIds.length) + missing.length,
				};
				continue;
			}
			messages.splice(Math.min(Math.max(0, entry.index), messages.length), 0, entry.row);
			added += 1;
		}
		if (added === 0 && messages.every((message, index) => message === state.messages[index])) return state;
		return { ...state, messages, total: state.total + added };
	}
	const messages = state.messages.flatMap((message) => {
		const next = withoutRemovedIds(message, action.ids);
		return next ? [next] : [];
	});
	const removed = state.messages.length - messages.length;
	if (!removed && messages.every((message, index) => message === state.messages[index])) return state;
	return { ...state, messages, total: Math.max(0, state.total - removed) };
}

function membershipFieldsOf(message: Message): MessageMembershipFields {
	return {
		status: message.status,
		folderId: message.folderId ?? null,
		snoozedUntil: message.snoozedUntil ?? null,
		starred: message.starred,
	};
}

/**
 * The state a member should have after the event. Committed events carry the
 * server's per-message state; optimistic events derive it from the action and
 * the row. `null` keeps the member until the authoritative event.
 */
function targetMembership(
	detail: MessagesChangedDetail,
	message: Message,
	id: string,
): MessageMembershipFields | "delete" | null {
	const authoritative = detail.states?.find((state) => state.id === id);
	if (authoritative) return authoritative;
	if (!detail.action || detail.action === "delete") return "delete";
	// A grouped row only exposes the representative's direction, while its
	// members may mix inbound and outbound. Defer direction-dependent decisions
	// to the committed event, which carries per-message state.
	if (DIRECTION_DEPENDENT_ACTIONS.has(detail.action) && message.threadMessageIds?.length) return null;
	const result = getMessageActionPatch(
		detail.action,
		{ folderId: detail.folderId, snoozedUntil: detail.snoozedUntil },
		{
			id,
			mailboxId: message.mailboxId,
			direction: message.direction,
			status: message.status,
			read: message.read,
			starred: message.starred,
			folderId: message.folderId ?? null,
			snoozedUntil: message.snoozedUntil ?? null,
		},
	);
	if ("patch" in result && result.patch) return { ...membershipFieldsOf(message), ...result.patch };
	return null;
}

function getRemovedMessageIds(
	detail: MessagesChangedDetail,
	messages: Message[],
	folder: MessageFolder,
	folderId: string | null | undefined,
	now: number,
): Set<string> {
	const affected = new Set(detail.messageIds ?? []);
	const removed = new Set<string>();
	if (affected.size === 0) return removed;
	for (const message of messages) {
		const members = message.threadMessageIds?.length ? message.threadMessageIds : [message.id];
		for (const id of members) {
			if (!affected.has(id)) continue;
			const target = targetMembership(detail, message, id);
			if (target === "delete") {
				removed.add(id);
				continue;
			}
			if (target && !messageMatchesFolder(target, folder, folderId, now)) removed.add(id);
		}
	}
	return removed;
}

export function useMessages(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
	enabled = true,
	folderId?: string | null,
) {
	// A folder switch remounts this hook, so paint the cached page immediately.
	const [initialPage] = useState(() => (
		enabled ? peekMessageList(getMessageQueryParams(folder, mailboxId, filters, folderId)) : undefined
	));
	const [list, dispatch] = useReducer(messageListReducer, {
		messages: initialPage?.messages ?? [],
		total: initialPage?.total ?? 0,
		limit: initialPage?.limit ?? filters?.limit ?? 25,
		offset: initialPage?.offset ?? filters?.offset ?? 0,
	});
	const [isLoading, setIsLoading] = useState(enabled && !initialPage);
	const listRef = useRef(list);
	useEffect(() => {
		listRef.current = list;
	}, [list]);
	const updateMessages = useCallback((updater: Message[] | ((current: Message[]) => Message[])) => {
		dispatch({ type: "update", updater: typeof updater === "function" ? updater : () => updater });
	}, []);

	const unreadCount = list.messages.filter((m) => m.direction === "inbound" && !m.read).length;

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let refreshTimer: number | null = null;
		let requestNumber = 0;
		const listKey = getListMembershipKey(getMessageQueryParams(folder, mailboxId, filters, folderId));
		async function loadMessages(force = false, showLoading = false) {
			const currentRequest = ++requestNumber;
			if (showLoading) setIsLoading(true);
			try {
				const params = getMessageQueryParams(folder, mailboxId, filters, folderId);
				const data = await fetchMessageList(params, force);
				if (!cancelled && currentRequest === requestNumber) {
					dispatch({
						type: "loaded",
						messages: applyPendingToMessages(data.messages ?? []),
						total: data.total ?? 0,
						limit: data.limit ?? filters?.limit ?? 25,
						offset: data.offset ?? filters?.offset ?? 0,
					});
				}
			} finally {
				if (!cancelled && currentRequest === requestNumber) setIsLoading(false);
			}
		}

		void loadMessages(false, !peekMessageList(getMessageQueryParams(folder, mailboxId, filters, folderId))).catch(() => undefined);
		const unregisterRefresh = registerMessageRefresh(() => loadMessages());
		function patchReadState(event: Event) {
			const detail = (event as CustomEvent<{
				kind?: string;
				messageIds?: string[];
				read?: boolean;
				threadTargets?: ThreadUnreadTarget[];
			}>).detail;
			if (detail?.kind !== "read" || !detail.messageIds?.length) return;
			const ids = new Set(detail.messageIds);
			const read = detail.read !== false;
			const targets = new Map((detail.threadTargets ?? []).map((target) => [target.id, target.threadUnread]));
			dispatch({
				type: "update",
				updater: (current) => applyPendingToMessages(current.map((message) => (
					patchThreadRow(message, ids, read, targets.get(message.id))
				))),
			});
		}
		function patchFieldState(event: Event) {
			const detail = (event as CustomEvent<{
				kind?: string;
				patches?: Array<{ id: string; read?: boolean; starred?: boolean }>;
				threadTargets?: ThreadUnreadTarget[];
			}>).detail;
			if (detail?.kind !== "patch" || !detail.patches?.length) return;
			const patches = new Map(detail.patches.map((patch) => [patch.id, patch]));
			const targets = new Map((detail.threadTargets ?? []).map((target) => [target.id, target.threadUnread]));
			dispatch({
				type: "update",
				updater: (current) => applyPendingToMessages(current.map((message) => {
					if (message.threadMessageIds?.length) {
						const memberPatches = message.threadMessageIds
							.map((id) => patches.get(id))
							.filter((patch): patch is { id: string; read?: boolean; starred?: boolean } => !!patch);
						if (memberPatches.length === 0) return message;
						const next = { ...message };
						let changed = false;
						const starred = memberPatches.find((patch) => patch.starred !== undefined)?.starred;
						if (starred !== undefined && next.starred !== starred) {
							next.starred = starred;
							changed = true;
						}
						const readPatch = memberPatches.find((patch) => patch.read !== undefined);
						if (readPatch?.read !== undefined) {
							const target = targets.get(message.id);
							const threadUnread = target !== undefined
								? clampThreadUnread(target, message.threadMessageIds.length)
								: getKnownThreadUnread(message.id) ?? next.threadUnread ?? 0;
							const read = threadUnread === 0;
							if (next.threadUnread !== threadUnread || next.read !== read) {
								next.threadUnread = threadUnread;
								next.read = read;
								changed = true;
							}
						}
						return changed ? next : message;
					}
					const patch = patches.get(message.id);
					if (!patch) return message;
					const next = { ...message };
					if (patch.starred !== undefined) next.starred = patch.starred;
					if (patch.read !== undefined) next.read = patch.read;
					return next;
				})),
			});
		}
		function patchRemovedState(event: Event) {
			const detail = (event as CustomEvent<MessagesChangedDetail>).detail;
			if (detail?.kind !== "removed" || !detail.messageIds?.length) return;
			const ids = getRemovedMessageIds(detail, listRef.current.messages, folder, folderId, Date.now());
			if (ids.size === 0) {
				// The optimistic prune already removed the row; the committed state
				// still has to update its tombstone for an exact rollback.
				if (detail.states?.length) updateRemovedRows(detail.states);
				return;
			}
			if (!detail.realtime && detail.action !== "delete") {
				const now = Date.now();
				listRef.current.messages.forEach((message, index) => {
					const members = message.threadMessageIds?.length ? message.threadMessageIds : [message.id];
					const removedMembers = members.filter((id) => ids.has(id));
					if (removedMembers.length > 0) {
						rememberRemovedRow(listKey, message, removedMembers, index, listRef.current.offset, now);
					}
				});
			}
			if (detail.states?.length) updateRemovedRows(detail.states);
			// A response that started before this mutation may still contain the row.
			requestNumber += 1;
			dispatch({ type: "removed", ids });
		}
		function patchRestoredState(event: Event) {
			const detail = (event as CustomEvent<MessagesChangedDetail>).detail;
			if (detail?.kind !== "restored") return;
			const wanted = new Set(detail.messageIds ?? []);
			const rows = getRestoredRowsForList(listKey, Date.now(), listRef.current.offset).filter((entry) => (
				entry.eligible.some((id) => wanted.has(id))
			));
			if (rows.length === 0) return;
			requestNumber += 1;
			dispatch({ type: "restored", rows });
		}
		function onMessagesChanged(event: Event) {
			const detail = (event as CustomEvent<{ kind?: string }>).detail;
			const readOnly = detail?.kind === "read";
			// A read patch can overtake a list request that started before it.
			requestNumber += 1;
			if (!readOnly) {
				clearMessageListCache();
				clearMessageCountsCache();
			}
			if (document.visibilityState !== "visible") return;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				void loadMessages(true).catch(() => undefined);
			}, REFRESH_DEBOUNCE_MS);
		}
		const unsubscribePending = subscribePendingOverlay(() => {
			dispatch({ type: "update", updater: (current) => applyPendingToMessages(current) });
		});
		window.addEventListener("mailflare:messages-changed", onMessagesChanged);
		window.addEventListener("mailflare:messages-changed", patchReadState);
		window.addEventListener("mailflare:messages-changed", patchFieldState);
		window.addEventListener("mailflare:messages-changed", patchRemovedState);
		window.addEventListener("mailflare:messages-changed", patchRestoredState);

		return () => {
			cancelled = true;
			unregisterRefresh();
			window.removeEventListener("mailflare:messages-changed", onMessagesChanged);
			window.removeEventListener("mailflare:messages-changed", patchReadState);
			window.removeEventListener("mailflare:messages-changed", patchFieldState);
			window.removeEventListener("mailflare:messages-changed", patchRemovedState);
			window.removeEventListener("mailflare:messages-changed", patchRestoredState);
			unsubscribePending();
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [enabled, filters?.group, filters?.limit, filters?.offset, filters?.query, filters?.read, filters?.title, folder, folderId, mailboxId]);

	return { messages: list.messages, unreadCount, isLoading, total: list.total, limit: list.limit, offset: list.offset, updateMessages };
}

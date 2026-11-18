import { useEffect, useState } from "react";
import type { Message, MessageFilterOptions, MessageFolder } from "./types";
import { applyPendingToMessages, getKnownThreadUnread, subscribePendingOverlay } from "@/lib/messages/field-store";
import type { ThreadUnreadTarget } from "@/lib/messages/field-store";
import { registerMessageRefresh } from "./message-refresh";
import {
	clearMessageCountsCache,
	clearMessageListCache,
	fetchMessageList,
	getMessageQueryParams,
	peekMessageList,
} from "./utils";

const REFRESH_DEBOUNCE_MS = 150;

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
	const [messages, setMessages] = useState<Message[]>(initialPage?.messages ?? []);
	const [isLoading, setIsLoading] = useState(enabled && !initialPage);
	const [total, setTotal] = useState(initialPage?.total ?? 0);
	const [limit, setLimit] = useState(initialPage?.limit ?? filters?.limit ?? 25);
	const [offset, setOffset] = useState(initialPage?.offset ?? filters?.offset ?? 0);

	const unreadCount = messages.filter((m) => m.direction === "inbound" && !m.read).length;

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let refreshTimer: number | null = null;
		let requestNumber = 0;
		async function loadMessages(force = false, showLoading = false) {
			const currentRequest = ++requestNumber;
			if (showLoading) setIsLoading(true);
			try {
				const params = getMessageQueryParams(folder, mailboxId, filters, folderId);
				const data = await fetchMessageList(params, force);
				if (!cancelled && currentRequest === requestNumber) {
					setMessages(applyPendingToMessages(data.messages ?? []));
					setTotal(data.total ?? 0);
					setLimit(data.limit ?? filters?.limit ?? 25);
					setOffset(data.offset ?? filters?.offset ?? 0);
				}
			} catch {
				// Keep the list already on screen when a refresh fails.
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
			setMessages((current) => applyPendingToMessages(current.map((message) => (
				patchThreadRow(message, ids, read, targets.get(message.id))
			))));
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
			setMessages((current) => applyPendingToMessages(current.map((message) => {
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
			})));
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
			setMessages((current) => applyPendingToMessages(current));
		});
		window.addEventListener("mailflare:messages-changed", onMessagesChanged);
		window.addEventListener("mailflare:messages-changed", patchReadState);
		window.addEventListener("mailflare:messages-changed", patchFieldState);

		return () => {
			cancelled = true;
			unregisterRefresh();
			window.removeEventListener("mailflare:messages-changed", onMessagesChanged);
			window.removeEventListener("mailflare:messages-changed", patchReadState);
			window.removeEventListener("mailflare:messages-changed", patchFieldState);
			unsubscribePending();
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [enabled, filters?.group, filters?.limit, filters?.offset, filters?.query, filters?.read, filters?.title, folder, folderId, mailboxId]);

	return { messages, unreadCount, isLoading, total, limit, offset, updateMessages: setMessages };
}

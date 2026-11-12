"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { authFetch } from "@/lib/auth/client";
import { fetchCachedMessageDetail, getCachedMessageDetail } from "@/lib/messages/detail-cache";
import { FULL_ROUTE_PREFETCH } from "@/lib/navigation/prefetch";
import type { MessageNavigationResponse } from "@/app/api/messages/navigation/types";
import type { MessageDetailNavigationContextValue, MessageDetailNavigationProps, MessageDetailNavigationProviderProps, MessageDetailNavigationSnapshot, OpenedUnreadMessages } from "./message-detail-navigation-types";
import { getMessageDetailNavigationState, takeOpenedUnreadMessage } from "./message-detail-navigation-utils";
import { useConversationView } from "./use-conversation-view";

const NavigationContext = createContext<MessageDetailNavigationContextValue | null>(null);

export function MessageDetailNavigationProvider({ children, config, currentMessageId }: MessageDetailNavigationProviderProps) {
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const [conversationView] = useConversationView();
	const grouped = conversationView && config.folder !== "drafts";
	const mailboxId = selectedMailbox?.id;
	const key = `${config.folder}:${config.folderId ?? ""}:${mailboxId ?? "all"}:${grouped}`;
	const [snapshot, setSnapshot] = useState<MessageDetailNavigationSnapshot>({ key: "", entries: [] });
	const [openedUnread, setOpenedUnread] = useState<OpenedUnreadMessages>({ key: "", ids: new Set() });
	const recordUnread = useCallback((messageId: string) => {
		setOpenedUnread((current) => {
			const ids = new Set(current.key === key ? current.ids : []);
			ids.add(messageId);
			return { key, ids };
		});
	}, [key]);

	useEffect(() => {
		const messageId = takeOpenedUnreadMessage();
		if (messageId) recordUnread(messageId);
	}, [recordUnread]);

	// Re-anchor if the open message falls outside the loaded window.
	const currentIndex = snapshot.key === key && currentMessageId
		? snapshot.entries.findIndex((entry) => entry.id === currentMessageId)
		: -1;
	const beyondWindow = snapshot.key !== key
		|| (snapshot.entries.length > 0 && currentIndex === -1)
		|| (currentIndex === 0 && snapshot.hasNewer === true)
		|| (currentIndex === snapshot.entries.length - 1 && snapshot.hasOlder === true);
	const requestAnchor = currentMessageId && beyondWindow ? currentMessageId : undefined;

	useEffect(() => {
		if (mailboxesLoading || !requestAnchor) return;
		let cancelled = false;
		const params = new URLSearchParams({ folder: config.folder });
		if (config.folderId) params.set("folderId", config.folderId);
		if (mailboxId) params.set("mailboxId", mailboxId);
		if (grouped) params.set("group", "thread");
		params.set("around", requestAnchor);
		void authFetch(`/api/messages/navigation?${params.toString()}`)
			.then((response) => {
				if (!response.ok) throw new Error("Unable to load message navigation");
				return response.json() as Promise<MessageNavigationResponse>;
			})
			.then((response) => {
				if (!cancelled) setSnapshot({ key, entries: response.messages, hasNewer: response.hasNewer, hasOlder: response.hasOlder });
			})
			.catch(() => {
				if (!cancelled) setSnapshot({ key, entries: [] });
			});
		return () => { cancelled = true; };
	}, [config.folder, config.folderId, grouped, key, mailboxId, mailboxesLoading, requestAnchor]);

	const unreadIds = openedUnread.key === key ? openedUnread.ids : null;
	const entries = snapshot.key === key
		? snapshot.entries.map((entry) => ({ ...entry, unread: entry.unread || !!unreadIds?.has(entry.id) }))
		: [];
	return <NavigationContext.Provider value={{ entries, hrefPrefix: config.hrefPrefix, recordUnread }}>{children}</NavigationContext.Provider>;
}

export function MessageDetailNavigation({ messageId, unread }: MessageDetailNavigationProps) {
	const { t } = useLanguage();
	const context = useContext(NavigationContext);
	const recordUnread = context?.recordUnread;
	const router = useRouter();
	useEffect(() => {
		if (unread) recordUnread?.(messageId);
	}, [recordUnread, messageId, unread]);

	const navigation = context
		? getMessageDetailNavigationState(context.entries, messageId)
		: null;
	const previousId = navigation?.previousId ?? null;
	const nextId = navigation?.nextId ?? null;
	const unreadOrder = navigation?.unreadOrder ?? 0;
	const totalUnread = navigation?.totalUnread ?? 0;

	useEffect(() => {
		if (!previousId && !nextId) return;
		const warm = (id: string | null) => {
			if (!id || getCachedMessageDetail(id)?.body) return;
			void fetchCachedMessageDetail(id, true).catch(() => {});
		};
		const run = () => {
			warm(previousId);
			warm(nextId);
		};
		if ("requestIdleCallback" in window) {
			const id = window.requestIdleCallback(run, { timeout: 1000 });
			return () => window.cancelIdleCallback(id);
		}
		const timer = setTimeout(run, 250);
		return () => clearTimeout(timer);
	}, [nextId, previousId]);

	if (!context) return null;
	const hrefPrefix = context.hrefPrefix;

	function prefetchMessage(id: string | null) {
		if (!id) return;
		router.prefetch(`${hrefPrefix}/${id}`, FULL_ROUTE_PREFETCH);
		if (!getCachedMessageDetail(id)?.body) void fetchCachedMessageDetail(id, true).catch(() => {});
	}

	return (
		<div className="ml-auto flex shrink-0 items-center gap-2 text-neutral-500">
			{totalUnread > 0 && (
			<span className="mr-2 whitespace-nowrap text-xs" aria-live="polite">
				{t("message.nav.unreadPosition", { position: unreadOrder, total: totalUnread })}
			</span>
			)}
			<Tooltip label={t("message.nav.newer")}>
				<Button
					type="button"
					variant="ghost"
					size="roundedSM"
					aria-label={t("message.nav.newer")}
					disabled={!previousId}
					onPointerEnter={() => prefetchMessage(previousId)}
					onFocus={() => prefetchMessage(previousId)}
					onTouchStart={() => prefetchMessage(previousId)}
					onClick={() => {
						prefetchMessage(previousId);
						if (previousId) router.push(`${hrefPrefix}/${previousId}`);
					}}
				>
					<ChevronLeft size={18} />
				</Button>
			</Tooltip>
			<Tooltip label={t("message.nav.older")}>
				<Button
					type="button"
					variant="ghost"
					size="roundedSM"
					aria-label={t("message.nav.older")}
					disabled={!nextId}
					onPointerEnter={() => prefetchMessage(nextId)}
					onFocus={() => prefetchMessage(nextId)}
					onTouchStart={() => prefetchMessage(nextId)}
					onClick={() => {
						prefetchMessage(nextId);
						if (nextId) router.push(`${hrefPrefix}/${nextId}`);
					}}
				>
					<ChevronRight size={18} />
				</Button>
			</Tooltip>
		</div>
	);
}

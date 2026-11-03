import { getMessageQueryParams, fetchMessageList } from "@/hooks/utils";
import type { MessageFolder } from "@/hooks/types";

export type MailboxPrefetchOptions = {
	/** The active search, so the prefetched key matches the page's first request. */
	query?: string;
	/** Conversation view state, which the list sends as `group=thread`. */
	grouped?: boolean;
};

export async function preloadMailboxPage(href: string, mailboxId?: string, options: MailboxPrefetchOptions = {}) {
	const customFolderMatch = href.match(/^\/folders\/([^/]+)$/);
	const folder = (customFolderMatch ? "inbox" : href.slice(1)) as MessageFolder;
	const supportedFolders: MessageFolder[] = ["inbox", "starred", "snoozed", "sent", "scheduled", "drafts", "archived", "spam", "trash"];
	if (!supportedFolders.includes(folder)) return;

	const params = getMessageQueryParams(
		folder,
		mailboxId,
		{
			query: options.query?.trim() || undefined,
			read: "all",
			limit: 25,
			offset: 0,
			group: options.grouped ? "thread" : undefined,
		},
		customFolderMatch?.[1],
	);
	await fetchMessageList(params);
}

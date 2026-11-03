import { getMessageQueryParams, fetchMessageList } from "@/hooks/utils";
import type { MessageFolder } from "@/hooks/types";

export type MailboxPrefetchOptions = {
	query?: string;
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

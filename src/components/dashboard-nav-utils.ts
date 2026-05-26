import type { MessageCounts, MessageFolder } from "@/hooks/types";

export function getFolderNavCount(folder: MessageFolder, counts: MessageCounts["folders"]): number {
	const count = counts[folder];
	if (folder === "inbox" || folder === "spam") return count.unread || count.total;
	return count.total;
}

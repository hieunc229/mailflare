import type { MessageCounts, MessageFolder } from "@/hooks/types";
import type { CountableFolder, MessageCountRow } from "./types";

export function getMessageFolder(row: MessageCountRow): CountableFolder {
	if (row.status === "trash") return "trash";
	if (row.status === "spam") return "spam";
	if (row.direction === "inbound" && row.status === "received") return "inbox";
	if (row.direction === "outbound" && row.status === "sent") return "sent";
	if (row.direction === "outbound" && row.status === "draft") return "drafts";
	return null;
}

export function createEmptyFolderCounts(): MessageCounts["folders"] {
	return {
		inbox: { total: 0, unread: 0 },
		sent: { total: 0, unread: 0 },
		drafts: { total: 0, unread: 0 },
		spam: { total: 0, unread: 0 },
		trash: { total: 0, unread: 0 },
	};
}

export function buildMessageCounts(rows: MessageCountRow[]): MessageCounts {
	const folders = createEmptyFolderCounts();
	const mailboxMap = new Map<string, { mailboxId: string; total: number; unread: number; inbox: number }>();

	for (const row of rows) {
		const folder = getMessageFolder(row);
		if (folder) {
			folders[folder].total += 1;
			if (!row.read) folders[folder].unread += 1;
		}

		if (!row.mailboxId) continue;

		const mailboxCount = mailboxMap.get(row.mailboxId) ?? {
			mailboxId: row.mailboxId,
			total: 0,
			unread: 0,
			inbox: 0,
		};
		mailboxCount.total += 1;
		if (!row.read) mailboxCount.unread += 1;
		if (folder === "inbox") mailboxCount.inbox += 1;
		mailboxMap.set(row.mailboxId, mailboxCount);
	}

	return {
		folders,
		mailboxes: [...mailboxMap.values()],
	};
}

export function getFolderLabelCount(folder: MessageFolder, counts: MessageCounts["folders"]) {
	const count = counts[folder];
	if (folder === "inbox" || folder === "spam") return count.unread || count.total;
	return count.total;
}

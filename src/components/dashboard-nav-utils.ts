import type { MessageCounts, MessageFolder } from "@/hooks/types";
import { performMessageAction } from "@/lib/messages/actions/client";

export function getFolderNavCount(folder: MessageFolder, counts: MessageCounts["folders"]): number | undefined {
	return counts[folder].unread;
}

async function moveMessages(payload: { messageIds: string[]; action: "archive" | "spam" | "trash" | "folder"; folderId?: string }) {
	await performMessageAction(payload);
}

export function moveMessagesToSystemFolder(messageIds: string[], action: "archive" | "spam" | "trash") {
	return moveMessages({ messageIds, action });
}

export function moveMessagesToCustomFolder(messageIds: string[], folderId: string) {
	return moveMessages({ messageIds, action: "folder", folderId });
}

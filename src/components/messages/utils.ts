import type { Message } from "@/hooks/types";
import type { MessageFolderConfig } from "./types";

export function getMessageParty(message: Message, folder: MessageFolderConfig["folder"]) {
	if (folder === "sent" || folder === "drafts") return message.toAddr || "No recipient";
	return message.fromAddr || "Unknown sender";
}

export function getMessagePreview(message: Message, folder: MessageFolderConfig["folder"]) {
	if (folder === "drafts") return message.snippet || message.toAddr || "No content";
	return message.snippet || "No preview";
}

export function getMessageBadge(message: Message, folder: MessageFolderConfig["folder"]) {
	if (folder === "drafts") return "draft";
	if (folder === "trash" || folder === "spam") return message.status;
	return message.direction;
}

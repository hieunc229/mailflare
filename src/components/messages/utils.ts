import type { Message } from "@/hooks/types";
import type { MessageFolderConfig } from "./types";

export function getMessageParty(message: Message, folder: MessageFolderConfig["folder"]) {
	if (folder === "drafts") return "Draft";
	if (folder === "sent") return message.toAddr || "No recipient";
	return message.fromAddr || "Unknown sender";
}

export function getMessagePartyClassName(message: Message, folder: MessageFolderConfig["folder"]) {
	if (folder === "drafts") return "truncate font-semibold text-red-600";

	const unread = message.direction === "inbound" && !message.read;
	return `truncate ${unread ? "font-bold text-neutral-900" : "font-semibold text-neutral-800"}`;
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

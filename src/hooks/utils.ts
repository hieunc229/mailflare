import type { MessageFolder } from "./types";

export function getMessageQueryParams(folder: MessageFolder, mailboxId?: string | null) {
	const params = new URLSearchParams();

	if (folder === "inbox") {
		params.set("direction", "inbound");
		params.set("status", "received");
	}

	if (folder === "sent") {
		params.set("direction", "outbound");
		params.set("status", "sent");
	}

	if (folder === "drafts") {
		params.set("direction", "outbound");
		params.set("status", "draft");
	}

	if (folder === "trash" || folder === "spam") {
		params.set("status", folder);
	}

	if (mailboxId) params.set("mailboxId", mailboxId);

	return params;
}

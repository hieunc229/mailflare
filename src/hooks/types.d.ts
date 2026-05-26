export type MessageStatus = "received" | "sent" | "draft" | "queued" | "failed" | "trash" | "spam";

export type MessageFolder = "inbox" | "sent" | "drafts" | "trash" | "spam";

export type MessageDirection = "inbound" | "outbound";

export type Message = {
	id: string;
	userId: string;
	mailboxId: string | null;
	direction: MessageDirection;
	providerMessageId: string | null;
	fromAddr: string;
	toAddr: string;
	subject: string | null;
	snippet: string | null;
	status: MessageStatus | string;
	read: boolean;
	threadId: string | null;
	createdAt: string;
};

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

export type MessageReadFilter = "all" | "read" | "unread";

export type MessageFilterOptions = {
	query?: string;
	read?: MessageReadFilter;
	title?: string;
};

export type FolderCount = {
	total: number;
	unread: number;
};

export type MailboxCount = {
	mailboxId: string;
	total: number;
	unread: number;
	inbox: number;
};

export type MessageCounts = {
	folders: Record<MessageFolder, FolderCount>;
	mailboxes: MailboxCount[];
};

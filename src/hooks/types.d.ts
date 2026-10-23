export type MessageStatus = "received" | "sent" | "draft" | "queued" | "failed" | "archived" | "trash" | "spam";

export type MessageFolder = "inbox" | "starred" | "snoozed" | "sent" | "scheduled" | "drafts" | "archived" | "trash" | "spam";

export type MessageDirection = "inbound" | "outbound";

export type Message = {
	id: string;
	userId: string;
	mailboxId: string | null;
	folderId: string | null;
	direction: MessageDirection;
	providerMessageId: string | null;
	fromAddr: string;
	/** Comma-separated recipient list; may include display names. */
	toAddr: string;
	ccAddr?: string | null;
	bccAddr?: string | null;
	/** Comma-separated Reply-To list; replies go here instead of `fromAddr` when set. */
	replyTo?: string | null;
	fromContactName?: string | null;
	fromContactHasAvatar?: boolean;
	toContactName?: string | null;
	subject: string | null;
	snippet: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
	status: MessageStatus | string;
	read: boolean;
	starred: boolean;
	snoozedUntil?: string | null;
	/** When a scheduled send will go out; set on rows in the Scheduled list. */
	scheduledAt?: string | null;
	/** Opens counted by the read-receipt pixel; absent when the message was sent without one. */
	openCount?: number;
	threadId: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	spamScore?: number | null;
	spamVerdict?: "inbox" | "suspicious" | "spam" | null;
	spamSignals?: string | null;
	spamAnalyzedAt?: string | null;
	spamAnalysisError?: string | null;
	/** Messages in the same conversation (excluding drafts and trash), when the list API computed it. */
	threadCount?: number;
	/** Unread messages in the conversation; zero means the grouped thread is read. */
	threadUnread?: number;
	/** In conversation view: every message this row stands for within the current folder. */
	threadMessageIds?: string[];
	createdAt: string;
};

export type ThreadMessage = Message & {
	textBody: string | null;
	htmlBody: string | null;
	attachments: Array<{
		contentId: string | null;
		disposition: "attachment" | "inline";
		filename: string;
		id: string;
		messageId: string;
		size: number;
		type: string;
	}>;
};

export type ThreadResponse = {
	threadId: string | null;
	messages?: ThreadMessage[];
	error?: string;
};

export type MessageReadFilter = "all" | "read" | "unread";

export type MessageFilterOptions = {
	query?: string;
	read?: MessageReadFilter;
	title?: string;
	limit?: number;
	offset?: number;
	/** "thread" collapses each conversation to its newest matching message. */
	group?: "thread";
};

export type MessageListResponse = {
	messages?: Message[];
	total?: number;
	limit?: number;
	offset?: number;
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
	customFolders: Record<string, FolderCount>;
	mailboxes: MailboxCount[];
};

export type MessageCountsDelta = {
	inboxUnreadDelta?: number;
};

export interface NewMessageNotification {
	/** The message's full From header, e.g. `"Name" <address>`. */
	from: string;
	/** Resolved sender label: a manually named contact, otherwise this message's From name. */
	fromName: string | null;
	mailboxId: string;
	messageId: string;
	subject: string | null;
	type: "new_message";
}

export interface AgentDraftNotification {
	mailboxId: string;
	draftId: string;
	type: "agent_draft";
}

export interface MailboxRevisionRow {
	mailbox_id: string;
	revision: number;
	permission: string;
}

export interface RevisionPing {
	type: "ping";
	revision: string | null;
}

export interface RevisionNotification {
	type: "revision";
	revision: string;
	changed: boolean;
}

export interface RealtimeNotificationRequest {
	userIds: string[];
	payload: NewMessageNotification | AgentDraftNotification;
}

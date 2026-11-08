export type ConversationNote = {
	id: string;
	html: string;
	/** The email of the conversation this note is about; null when it is about the whole conversation. */
	messageId: string | null;
	/** Display name of the author; null once that account is gone. */
	authorName: string | null;
	createdAt: string;
	updatedAt: string;
	/** Whether the user who listed the notes may change this note's text. */
	canEdit: boolean;
	/** Whether the user who listed the notes may delete this note. */
	canDelete: boolean;
};

/** The conversation of one email, as seen by a user who may read its mailbox. */
export type NoteConversation = {
	mailboxId: string;
	threadKey: string;
	/**
	 * threadKey plus the looked-up email's own id. Sending a queued message
	 * rewrites its thread_id (send.ts), so notes keyed before that move hide
	 * under the message id; lookups must accept either key.
	 */
	threadKeys: string[];
	/** The email the conversation was looked up from. */
	messageId: string;
	/** The user has full access to the mailbox, so they may delete anyone's note. */
	canManage: boolean;
};

export type NoteChangeResult =
	| { ok: true; note: ConversationNote }
	| { ok: false; error: "not_found" | "forbidden" };

export type ConversationNote = {
	id: string;
	html: string;
	/** The email of the conversation this note is about; null when it is about the whole conversation. */
	messageId: string | null;
	/** Display name of the author; null once that account is gone. */
	authorName: string | null;
	/** Id of the author's account; null once that account is gone. */
	authorId: string | null;
	/** The author has a profile picture, served by the notes avatar route. */
	authorHasAvatar: boolean;
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
	 * threadKey plus the id of every email in the conversation. A queued
	 * message keys its conversation by its own id; send.ts rekeys the thread
	 * by the provider Message-ID, so notes taken before that move hide under
	 * the message id and must be found from any other email of the thread,
	 * e.g. a reply that arrives after the send.
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

export type ConversationNote = {
	id: string;
	/** HTML from the note editor; the reader sanitizes it. Older notes may be plain text. */
	body: string;
	/** The email of the conversation this note is attached to, if any. */
	messageId: string | null;
	/** The account that wrote the note; null once that account is gone. */
	authorId: string | null;
	authorName: string | null;
	/** Whether the author has an avatar the reader may fetch through the notes avatar route. */
	authorHasAvatar: boolean;
	createdAt: string;
};

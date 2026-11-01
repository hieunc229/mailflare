export type ConversationNote = {
	id: string;
	html: string;
	/** Display name of the account that saved the note last; null once that account is gone. */
	savedByName: string | null;
	updatedAt: string;
};

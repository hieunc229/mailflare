export type ResolveThreadInput = {
	mailboxId: string | null;
	/** The message's own Message-ID; seeds a new thread when no parent is stored. */
	messageId: string | null;
	inReplyTo?: string | null;
	references?: string[];
	/** Bare sender address of an inbound message; a stranger cannot join a conversation by naming its Message-ID. */
	senderAddress?: string | null;
};

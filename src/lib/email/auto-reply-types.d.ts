export type MailboxAutoReplyInput = {
	mailboxId: string;
	userId: string;
	deliveredAddress: string;
	fromAddress: string;
	/** The SMTP MAIL FROM address; empty or "<>" marks a bounce. */
	envelopeFrom?: string | null;
	incomingMessageId?: string | null;
	headers?: Record<string, string>;
};

import type { mailboxes } from "@/db/schema";

export type SeedMailboxKey = "support" | "billing";

export type SeedMailboxMap = Record<SeedMailboxKey, typeof mailboxes.$inferSelect>;

export type SeedMessageStatus =
	| "received"
	| "sent"
	| "draft"
	| "trash"
	| "spam"
	| "queued"
	| "failed";

/**
 * Synthetic delivery headers: trusted messages get an SES trace; untrusted
 * ones get a forged Authentication-Results header without a receipt.
 */
export type SeedRawMessageOptions = {
	trusted: boolean;
	spf?: "pass" | "fail";
	dkim?: "pass" | "fail";
	dmarc?: "pass" | "fail";
	signedBy?: string;
	mailedBy?: string;
	senderIp?: string;
	tls?: string;
};

export type SeedMessageDefinition = {
	mailbox: SeedMailboxKey;
	direction: "inbound" | "outbound";
	status: SeedMessageStatus;
	fromAddr: string;
	toAddr: string;
	ccAddr?: string;
	bccAddr?: string;
	replyTo?: string;
	subject: string;
	textBody: string;
	read?: boolean;
	minutesAgo: number;
	providerMessageId?: string;
	/** Thread id shared with related demo messages; defaults to the provider message id. */
	threadId?: string;
	inReplyTo?: string;
	references?: string;
	/** When set, stores matching RFC822 source in R2. */
	raw?: SeedRawMessageOptions;
};

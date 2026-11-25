export type BlockContactRequest = {
	mailboxId?: string;
	address?: string;
	/** "domain" blocks everything from the sender's domain instead of the one address. */
	scope?: "address" | "domain";
};

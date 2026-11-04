import type { contacts } from "@/db/schema";
import type { ContactSource } from "@/lib/email/address-types";

export type ContactRow = typeof contacts.$inferSelect;

export type ContactInput = {
	userId: string;
	address: string;
	source: ContactSource;
	/** False skips the Gravatar lookup, which tells a third party that this address mailed us. */
	lookupAvatar?: boolean;
};

export type BlockContactInput = {
	userId: string;
	mailboxId: string;
	domainId: string;
	address: string;
};

export type ContactDisplayName = {
	displayName: string;
	source: ContactSource;
};

export type MessageContactNames = {
	/** Resolved sender label: a manually named contact, otherwise the message's From name. */
	fromContactName: string | null;
	toContactName: string | null;
};

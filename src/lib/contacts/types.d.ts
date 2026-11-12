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

/** A stored contact as sender/recipient resolution sees it; the learned name may be absent. */
export type ContactNameSource = {
	displayName: string | null;
	source: ContactSource;
};

export type ContactCard = {
	displayName: string | null;
	source: ContactSource;
	hasAvatar: boolean;
};

export type MessageContactNames = {
	/** Resolved sender label: a manually named contact, otherwise the message's From name. */
	fromContactName: string | null;
	/** Resolved recipient label: a manually named contact, otherwise the message's To name. */
	toContactName: string | null;
};

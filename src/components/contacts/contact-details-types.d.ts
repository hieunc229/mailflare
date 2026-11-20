import type { ContactDetailsData } from "@/lib/contacts/details-types";

export type ContactDetailsRecord = {
	email: string;
	displayName: string | null;
	hasAvatar: boolean;
	source: "manual" | "inbound" | "outbound" | "import" | null;
	blocked: boolean;
	lastSeenAt: string | null;
	/** Phones, addresses and so on brought in by a contact import. */
	details?: ContactDetailsData;
};

export type ContactDetailsResponse = {
	contact?: ContactDetailsRecord;
	error?: string;
};

export type ContactDetailsTriggerProps = {
	mailboxId: string | null;
	address: string;
	/** Contact name. Not the formatted Name <mailbox> label. */
	name: string;
	/** Visible text. Falls back to name. */
	label?: string;
	className?: string;
};

export type ContactImportedDetailsProps = {
	details?: ContactDetailsData;
	/** The contact's own address, left out of "other addresses". */
	address: string;
};

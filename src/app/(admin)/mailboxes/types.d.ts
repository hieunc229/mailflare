export type Mailbox = {
	id: string;
	localPart: string;
	displayName: string | null;
	hasAvatar?: boolean;
	domainId: string;
	hostname: string;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	isPrimary?: boolean;
	status?: "active" | "disabled" | "pendingDeletion";
	lastSignInAt?: string | null;
};

export type Domain = {
	id: string;
	hostname: string;
};

export type CurrentAccountResponse = {
	user?: {
		id?: string;
		email?: string;
		name?: string | null;
	};
};

export type MailboxOwner = {
	id: string;
	email: string;
	name: string;
	role: "admin" | "user";
};

export type MailboxesResponse = {
	mailboxes: Mailbox[];
	canCreateShared: boolean;
};

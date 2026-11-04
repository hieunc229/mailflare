export type MailboxDetail = {
	id: string;
	userId: string;
	domainId: string;
	localPart: string;
	displayName: string | null;
	useAllDomains: boolean;
	hasAvatar?: boolean;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access" | null;
	canManageSharing?: boolean;
	disabled?: boolean;
	createdAt: string;
	hostname: string;
	isPrimary?: boolean;
};

export type MailboxDetailResponse = {
	mailbox?: MailboxDetail;
	error?: string;
};

export type MailboxAvatarFormProps = {
	mailboxId: string;
	hasAvatar: boolean;
	name: string;
};

export type MailboxAvatarUploadResponse = {
	error?: string;
};

export type MailboxAlias = {
	id: string;
	domainId: string;
	localPart: string;
	hostname: string;
	createdAt: string;
};

export type MailboxAliasDomain = {
	id: string;
	hostname: string;
};

export type MailboxAliasesResponse = {
	aliases: MailboxAlias[];
	availableDomains: MailboxAliasDomain[];
	error?: string;
};

export type SharedInboxMember = {
	id: string;
	userId: string;
	userEmail: string;
	userName: string;
	permission: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	createdAt: string;
};

export type SharedInboxAccount = {
	id: string;
	email: string;
	name: string;
	role: "admin" | "user";
};

export type SharedInboxAccessResponse = {
	members: SharedInboxMember[];
	availableUsers: SharedInboxAccount[];
	error?: string;
};

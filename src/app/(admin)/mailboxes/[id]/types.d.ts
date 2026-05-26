export type MailboxDetail = {
	id: string;
	userId: string;
	domainId: string;
	localPart: string;
	displayName: string | null;
	createdAt: string;
	hostname: string;
	isPrimary?: boolean;
};

export type MailboxDetailResponse = {
	mailbox?: MailboxDetail;
	error?: string;
};

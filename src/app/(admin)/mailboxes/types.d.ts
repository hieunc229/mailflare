export type Mailbox = {
	id: string;
	localPart: string;
	displayName: string | null;
	domainId: string;
	hostname: string;
	isPrimary?: boolean;
};

export type Domain = {
	id: string;
	hostname: string;
};

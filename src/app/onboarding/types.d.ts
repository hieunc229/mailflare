export type DomainListResult = {
	domains?: { id: string; hostname: string }[];
};

export type DomainCreateResult = {
	domain?: { id: string };
	error?: string;
};

export type MailboxCreateResult = {
	error?: string;
};

export type Domain = {
	id: string;
	hostname: string;
	status?: string;
};

export type AccountAliasDraft = {
	id: string;
	domainId: string;
	localPart: string;
};

export type AccountAliasesProps = {
	domains: Domain[];
	domainId: string;
	username: string;
	useAllDomains: boolean;
	onUseAllDomainsChange: (value: boolean) => void;
	aliases: AccountAliasDraft[];
	onAliasesChange: (aliases: AccountAliasDraft[]) => void;
};

export type Account = {
	id: string;
	email: string;
	name: string;
	resetEmail: string | null;
	role: "admin" | "user";
	isPrimaryAdmin?: boolean;
	disabled?: boolean;
	hasAvatar?: boolean;
	canManageMailboxes?: boolean;
	canManageDomains?: boolean;
	canManageUsers?: boolean;
	calendarEnabled?: boolean;
	driveEnabled?: boolean;
	createdAt: string;
	lastSignInAt?: string | null;
	deletedAt?: string | null;
	mailboxId?: string | null;
	localPart?: string | null;
	hostname?: string | null;
};

export type AccountResponse = {
	accounts?: Account[];
	seats?: { limit: number | null; used: number };
	account?: Account;
	error?: string;
};

export type AppPasswordSummary = {
	id: string;
	name: string;
	/** An older JMAP-only key, listed beside app passwords. */
	legacy: boolean;
	protocols: string[];
	createdAt: string;
	lastUsedAt: string | null;
	lastUsedProtocol: string | null;
	lastUsedIp: string | null;
};

export type AppPasswordList = {
	appPasswords: AppPasswordSummary[];
	/** The scopes this server can serve, in the order to offer them. */
	availableProtocols: string[];
	/** Full `/jmap/session` URL from APP_URL or the request origin, for apps that do not do /.well-known discovery. */
	jmapSessionUrl?: string;
};

export type NewAppPassword = {
	name: string;
	protocols: string[];
	mailboxIds: string[];
};

export type CreatedAppPassword = NewAppPassword & {
	id: string;
	/** The password itself, returned once. */
	key: string;
};

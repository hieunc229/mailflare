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
	dav: DavStatus;
};

/** What the page needs to explain calendar and contacts sync and to build its addresses. */
export type DavStatus = {
	/** The administrator's switch. */
	enabled: boolean;
	userId: string;
	/** The account address, a sensible username for the device. */
	email: string;
	/** Off for this user means the calendar part answers 403 while contacts still sync. */
	calendarEnabled: boolean;
	isAdmin: boolean;
	/** The address to give devices: APP_URL when set, else the origin the request came to. */
	origin: string;
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

export type GroupActor = {
	id: string;
	canManageMailboxes: boolean;
	createdByUserId: string | null;
};

export type GroupSummary = {
	id: string;
	domainId: string;
	hostname: string;
	localPart: string;
	address: string;
	name: string;
	description: string | null;
	whoCanPost: "anyone" | "org" | "members";
	replyTo: "sender" | "group";
	/** Anyone-group only: relay posts from outside senders to external members too. */
	relayOutsidePosts: boolean;
	disabled: boolean;
	memberCount: number;
	/** False when the domain has no way to send, so external members would receive nothing. */
	canSend: boolean;
	createdAt: string;
};

export type GroupMemberView = {
	id: string;
	kind: "user" | "mailbox" | "external";
	userId: string | null;
	mailboxId: string | null;
	email: string | null;
	canSendAs: boolean;
	/** False for an account with no personal mailbox at its own address: send-as has nowhere to show up for it. */
	hasPrimaryMailbox: boolean;
	name: string;
	address: string;
	disabled: boolean;
	/** An external member whose address is on the domain's confirmed suppression list. */
	suppressed: boolean;
	createdAt: string;
};

export type GroupCandidate = { kind: "user" | "mailbox"; id: string; name: string; address: string };

export type GroupResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

/** Besides its members, what the group page warns about. */
export type GroupNotices = {
	/** False without a public HTTPS `APP_URL`: relayed copies then have no unsubscribe link. */
	unsubscribeReady: boolean;
	/** A send cap that stopped relays in the last 24 hours, or null. */
	relayCapped: { scope: "group" | "installation"; period: "hour" | "day"; limit: number; at: string } | null;
};

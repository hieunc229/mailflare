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
	disabled: boolean;
	memberCount: number;
	createdAt: string;
};

export type GroupMemberView = {
	id: string;
	kind: "user" | "mailbox" | "external";
	userId: string | null;
	mailboxId: string | null;
	email: string | null;
	canSendAs: boolean;
	name: string;
	address: string;
	disabled: boolean;
	createdAt: string;
};

export type GroupCandidate = { kind: "user" | "mailbox"; id: string; name: string; address: string };

export type GroupResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

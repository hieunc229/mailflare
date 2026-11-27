import type { mailboxes } from "@/db/schema";

export type MailboxPermission = "read_only" | "send_as" | "send_on_behalf" | "full_access";

export type MailboxType = "personal" | "shared";

export type MailboxAccessLevel = {
	mailbox: typeof mailboxes.$inferSelect;
	permission: MailboxPermission;
	isOwner: boolean;
	canRead: boolean;
	canSendAs: boolean;
	canSendOnBehalf: boolean;
	canManage: boolean;
};

export type AuditAction =
	| "auth.login"
	| "auth.logout"
	| "email.send"
	| "email.approve_send"
	| "email.read"
	| "email.delete"
	| "permission.change"
	| "mailbox.access";

export type AuditLogInput = {
	actorUserId?: string | null;
	targetUserId?: string | null;
	mailboxId?: string | null;
	messageId?: string | null;
	action: AuditAction | string;
	metadata?: Record<string, unknown>;
};

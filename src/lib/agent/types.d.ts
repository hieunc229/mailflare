import type { SessionUser } from "@/lib/auth/types";

export type EmailToolName = "list_emails" | "get_email" | "get_thread" | "set_note" | "search_emails" | "draft_email" | "draft_reply" | "edit_draft" | "review_draft_send" | "mark_email_read" | "move_email" | "move_emails" | "discard_draft";

export type AgentDraftEditInput = {
	draftId: string;
	expectedRevision: number;
	from?: string;
	to?: string;
	cc?: string | null;
	bcc?: string | null;
	subject?: string;
	body?: string;
	scheduledAt?: string | null;
	addAttachments?: { sourceEmailId: string; attachmentId: string }[];
	removeAttachmentIds?: string[];
};

export type AgentToolContext = {
	env: CloudflareEnv;
	user: SessionUser;
	mailboxId: string;
	origin: "chat" | "auto" | "mcp";
	timeZone?: string;
};

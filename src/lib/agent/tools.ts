import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { scheduledMessageCondition } from "@/lib/email/scheduled";
import { getDb } from "@/db";
import { agentDraftMetadata, domains, mailboxes, messages } from "@/db/schema";
import { buildSnippet } from "@/lib/email/parse";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { buildReplyReferences, formatMessageIdHeader, parseMessageIdList } from "@/lib/email/threading";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { buildSearchConditions } from "@/lib/search/conditions";
import { newId } from "@/lib/ids";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { listMessageAttachments } from "@/lib/email/attachments";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { updateMessageStatusForUser } from "@/lib/user";
import type { AgentToolContext, EmailToolName } from "./types";
import { getReplyRecipients } from "./reply";
import { formatAgentDraftBody } from "./draft-format";
import { editAgentDraft } from "./edit-draft";
import { requestAgentSend } from "./approvals/utils";
import type { AgentDraftEditInput } from "./types";

const id = z.string().min(1).max(160);
const body = z.string().trim().min(1).max(40_000).describe("The recipient-facing email body as ordinary prose. Do not use Markdown or HTML formatting.");
const limit = z.number().int().min(1).max(50).default(20);

export const emailToolSchemas = {
	list_emails: z.object({ folder: z.enum(["inbox", "sent", "scheduled", "draft", "archived", "trash", "spam"]).default("inbox"), limit, cursor: id.optional() }),
	get_email: z.object({ emailId: id }),
	get_thread: z.object({ emailId: id }),
	search_emails: z.object({ query: z.string().trim().min(1).max(300), folder: z.enum(["inbox", "sent", "scheduled", "draft", "archived", "trash", "spam"]).optional(), limit }),
	draft_email: z.object({ to: z.string().email(), subject: z.string().trim().min(1).max(500), body }),
	draft_reply: z.object({ emailId: id, body, replyAll: z.boolean().default(false) }),
	edit_draft: z.object({
		draftId: id, expectedRevision: z.number().int().positive(),
		from: z.string().max(320).optional(), to: z.string().max(2_000).optional(),
		cc: z.string().max(2_000).nullable().optional(), bcc: z.string().max(2_000).nullable().optional(),
		subject: z.string().max(500).optional(), body: z.string().max(40_000).optional(),
		scheduledAt: z.string().max(40).nullable().optional(),
		addAttachments: z.array(z.object({ sourceEmailId: id, attachmentId: id })).max(10).optional(),
		removeAttachmentIds: z.array(id).max(10).optional(),
	}),
	review_draft_send: z.object({ draftId: id, expectedRevision: z.number().int().positive() }),
	mark_email_read: z.object({ emailId: id, read: z.boolean() }),
	move_email: z.object({ emailId: id, destination: z.enum(["inbox", "archived", "trash", "spam"]) }),
	move_emails: z.object({ emailIds: z.array(id).min(1).max(20), destination: z.enum(["inbox", "archived", "trash", "spam"]) }),
	discard_draft: z.object({ draftId: id, expectedRevision: z.number().int().positive() }),
} as const;

export const emailToolDescriptions: Record<EmailToolName, string> = {
	list_emails: "List email metadata in a mailbox folder with pagination.",
	get_email: "Read one email and its attachment metadata without marking it read.",
	get_thread: "Read the recent conversation containing an email before drafting a reply.",
	search_emails: "Search email subject and body in this mailbox.",
	draft_email: "Save a new email draft. This never sends.",
	draft_reply: "Save a reply draft with recipients and threading derived from the source email. This never sends.",
	edit_draft: "Update a draft created by the assistant in the selected mailbox. First read it with get_email to get its current revision and attachment IDs. Can change sender, recipients, subject, body, requested schedule, and copy or remove attachments from accessible emails. Use an ISO 8601 send time with timezone offset; null clears it. This never sends or schedules delivery by itself.",
	review_draft_send: "Create a review link for the current assistant draft revision. The user must explicitly confirm before the email is sent or scheduled. This tool never sends or queues an email.",
	mark_email_read: "Mark an email as read or unread.",
	move_email: "Move an email to inbox, archive, trash, or spam.",
	move_emails: "Move up to 20 emails to inbox, archive, trash, or spam after user approval in chat.",
	discard_draft: "Discard an unedited agent draft by ID and revision.",
};

export const EMAIL_TOOL_NAMES = Object.keys(emailToolSchemas) as EmailToolName[];

function publicMessage(row: typeof messages.$inferSelect) {
	return {
		id: row.id, mailboxId: row.mailboxId, from: row.fromAddr, to: row.toAddr,
		cc: row.ccAddr, subject: row.subject, snippet: row.snippet, direction: row.direction,
		status: row.status, read: row.read, starred: row.starred, threadId: row.threadId,
		url: `/${row.status === "draft" ? "drafts" : row.status === "received" ? "inbox" : row.status}/${encodeURIComponent(row.id)}`,
		createdAt: row.createdAt,
	};
}

async function requireAccess(context: AgentToolContext, write = false, manage = false) {
	const access = await getMailboxAccessLevel(getDb(context.env), context.user, context.mailboxId);
	if (!access?.canRead || (write && !access.canSendOnBehalf) || (manage && !access.canManage)) {
		throw new Error("Mailbox not found or permission denied");
	}
	return access;
}

async function ownMessage(context: AgentToolContext, messageId: string) {
	await requireAccess(context);
	const [row] = await getDb(context.env).select().from(messages).where(and(eq(messages.id, messageId), eq(messages.mailboxId, context.mailboxId))).limit(1);
	if (!row || (row.status === "draft" && row.userId !== context.user.id)) throw new Error("Message not found");
	return row;
}

async function createDraft(context: AgentToolContext, input: { to: string; cc?: string; subject: string; body: string; source?: typeof messages.$inferSelect }) {
	await requireAccess(context, true);
	const formattedBody = formatAgentDraftBody(input.body);
	if (!formattedBody.text) throw new Error("Draft body is empty");
	const db = getDb(context.env);
	const [mailbox] = await db.select({ localPart: mailboxes.localPart, hostname: domains.hostname }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id)).where(eq(mailboxes.id, context.mailboxId)).limit(1);
	if (!mailbox) throw new Error("Mailbox not found");
	const sender = await getAuthorizedSenderAddress(context.env, { userId: context.user.id, mailboxId: context.mailboxId, from: `${mailbox.localPart}@${mailbox.hostname}` });
	const source = input.source;
	const references = source ? buildReplyReferences(parseMessageIdList(source.references), source.providerMessageId) : [];
	const draftId = newId("msg");
	await db.insert(messages).values({
		id: draftId, userId: context.user.id, mailboxId: context.mailboxId,
		direction: "outbound", fromAddr: sender.fromAddr, toAddr: input.to, ccAddr: input.cc || null,
		subject: input.subject, textBody: formattedBody.text, htmlBody: formattedBody.html, snippet: buildSnippet(formattedBody.text, null),
		status: "draft", read: true, inReplyTo: source?.providerMessageId ?? null,
		references: references.length ? formatMessageIdHeader(references) : null,
		threadId: source?.threadId ?? null,
	});
	try {
		await db.insert(agentDraftMetadata).values({ draftId, mailboxId: context.mailboxId, origin: context.origin, sourceMessageId: source?.id ?? null });
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, draftId));
		throw error;
	}
	return { draftId, revision: 1, sourceMessageId: source?.id ?? null, status: "draft_created", composerUrl: `/drafts/${draftId}` };
}

export async function runEmailTool(context: AgentToolContext, name: EmailToolName, rawInput: unknown): Promise<unknown> {
	const input = emailToolSchemas[name].parse(rawInput) as Record<string, unknown>;
	const db = getDb(context.env);
	if (name === "list_emails" || name === "search_emails") {
		await requireAccess(context);
		const folder = (name === "list_emails" ? input.folder : input.folder) as string | undefined;
		const conditions = [eq(messages.mailboxId, context.mailboxId)];
		if (folder === "draft") conditions.push(eq(messages.status, "draft"), eq(messages.userId, context.user.id));
		else if (folder === "sent") conditions.push(eq(messages.status, "sent"));
		else if (folder === "scheduled") conditions.push(scheduledMessageCondition(db));
		else if (folder === "inbox") conditions.push(eq(messages.status, "received"), isNull(messages.folderId));
		else if (folder === "archived" || folder === "trash" || folder === "spam") conditions.push(eq(messages.status, folder));
		else conditions.push(or(eq(messages.userId, context.user.id), eq(messages.direction, "inbound"))!);
		if (name === "search_emails") conditions.push(...buildSearchConditions(input.query as string, context.timeZone));
		if (input.cursor) {
			const cursor = await ownMessage(context, input.cursor as string);
			conditions.push(lt(messages.createdAt, cursor.createdAt));
		}
		const pageSize = input.limit as number;
		const rows = await db.select().from(messages).where(and(...conditions)).orderBy(desc(messages.createdAt)).limit(pageSize + 1);
		return { emails: rows.slice(0, pageSize).map(publicMessage), nextCursor: rows.length > pageSize ? rows[pageSize - 1]?.id : null };
	}
	if (name === "get_email") {
		const row = await ownMessage(context, input.emailId as string);
		const attachments = await listMessageAttachments(context.env, row.id);
		const text = (row.textBody || htmlToReadableText(row.htmlBody)).slice(0, 30_000);
		const [metadata] = row.status === "draft" ? await db.select({ revision: agentDraftMetadata.revision, scheduledAt: agentDraftMetadata.scheduledAt }).from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, row.id)).limit(1) : [];
		return { ...publicMessage(row), ...(row.status === "draft" ? { bcc: row.bccAddr, revision: metadata?.revision ?? null, scheduledAt: metadata?.scheduledAt?.toISOString() ?? null } : {}), text, truncated: (row.textBody || row.htmlBody || "").length > 30_000, attachments: attachments.map(({ id, filename, size, type }) => ({ id, filename, size, contentType: type })) };
	}
	if (name === "get_thread") {
		const anchor = await ownMessage(context, input.emailId as string);
		const rows = anchor.threadId
			? await db.select().from(messages).where(and(eq(messages.mailboxId, context.mailboxId), eq(messages.threadId, anchor.threadId))).orderBy(desc(messages.createdAt)).limit(21)
			: [anchor];
		return { emails: rows.slice(0, 20).reverse().filter((row) => row.status !== "draft" || row.userId === context.user.id).map((row) => ({ ...publicMessage(row), text: (row.textBody || htmlToReadableText(row.htmlBody)).slice(0, 5_000) })), truncated: rows.length > 20 };
	}
	if (name === "draft_email") return createDraft(context, { to: input.to as string, subject: input.subject as string, body: input.body as string });
	if (name === "draft_reply") {
		const source = await ownMessage(context, input.emailId as string);
		if (source.direction !== "inbound" || source.status === "spam" || source.status === "trash") throw new Error("Cannot reply to this message");
		const recipients = await getReplyRecipients(context, source, input.replyAll as boolean);
		const subject = /^Re:/i.test(source.subject ?? "") ? source.subject! : `Re: ${source.subject ?? ""}`;
		return createDraft(context, { ...recipients, subject, body: input.body as string, source });
	}
	if (name === "edit_draft") return editAgentDraft(context, input as unknown as AgentDraftEditInput);
	if (name === "review_draft_send") {
		if (context.origin !== "chat") throw new Error("Open the draft in Mailflare to review delivery");
		const draft = await ownMessage(context, input.draftId as string);
		if (draft.status !== "draft") throw new Error("Draft not found in the selected mailbox");
		const result = await requestAgentSend(context.env, context.user, input.draftId as string, input.expectedRevision as number);
		return { draftId: input.draftId, revision: input.expectedRevision, status: "pending_approval", scheduledAt: result.snapshot.scheduledAt, reviewUrl: result.reviewUrl };
	}
	if (name === "mark_email_read") {
		const row = await ownMessage(context, input.emailId as string);
		if (context.origin === "chat") return { action: name, status: "pending_approval", emailId: row.id, read: input.read, emails: [publicMessage(row)] };
		await db.update(messages).set({ read: input.read as boolean }).where(eq(messages.id, row.id));
		return { emailId: row.id, read: input.read };
	}
	if (name === "move_email" || name === "move_emails") {
		await requireAccess(context, false, true);
		const ids = name === "move_email" ? [input.emailId as string] : [...new Set(input.emailIds as string[])];
		const rows = await Promise.all(ids.map((messageId) => ownMessage(context, messageId)));
		if (rows.some((row) => row.status === "draft" || row.status === "sent")) throw new Error("Cannot move this message");
		const destination = input.destination as string;
		if (context.origin === "chat") return { action: name, status: "pending_approval", emailIds: ids, destination, emails: rows.map(publicMessage) };
		for (const row of rows) {
			const moved = await updateMessageStatusForUser(context.env, context.user, row.id, destination === "inbox" ? "received" : destination);
			if (!moved) throw new Error("Message could not be moved");
		}
		return { emailIds: ids, destination, status: "approved" };
	}
	if (name === "discard_draft") {
		const row = await ownMessage(context, input.draftId as string);
		const [metadata] = await db.select().from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, row.id)).limit(1);
		if (row.status !== "draft" || !metadata || metadata.revision !== input.expectedRevision || metadata.humanEditedAt) throw new Error("Draft changed or cannot be discarded");
		if (context.origin === "chat") return { action: name, status: "pending_approval", draftId: row.id, expectedRevision: input.expectedRevision, emails: [publicMessage(row)] };
		await deleteMessageWithObjects(context.env, db, row.id, row.rawR2Key);
		return { draftId: row.id, status: "discarded" };
	}
	throw new Error("Unknown tool");
}

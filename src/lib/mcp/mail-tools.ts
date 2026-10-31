import { and, asc, desc, eq, exists, gt, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contacts, folders, messages } from "@/db/schema";
import { charIndex, concatText } from "@/db/sql";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { SessionUser } from "@/lib/auth/types";
import type { McpMailToolName } from "./types";
import { parseSnoozeUntil } from "./mail-tools-utils";

const id = z.string().min(1).max(160);

export const mcpMailToolSchemas = {
	list_folders: z.object({ mailboxId: id }),
	star_email: z.object({ mailboxId: id, emailId: id, starred: z.boolean() }),
	snooze_email: z.object({ mailboxId: id, emailId: id, until: z.string().max(40).nullable().describe("ISO 8601 time with timezone offset when the email returns to Inbox, or null to unsnooze now.") }),
	move_to_folder: z.object({ mailboxId: id, emailIds: z.array(id).min(1).max(20), folderId: id.nullable().describe("A folder ID from list_folders, or null to take the emails out of their folder and back to Inbox.") }),
	search_contacts: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) }),
} as const;

export const MCP_MAIL_TOOL_NAMES = Object.keys(mcpMailToolSchemas) as McpMailToolName[];

export const mcpMailToolScopes: Record<McpMailToolName, string> = {
	list_folders: "mcp:read", search_contacts: "mcp:read",
	star_email: "mcp:organize", snooze_email: "mcp:organize", move_to_folder: "mcp:organize",
};

export const mcpMailToolDescriptions: Record<McpMailToolName, string> = {
	list_folders: "List the custom folders of a mailbox. Pass a folder ID to list_emails or search_emails as folderId, or to move_to_folder.",
	star_email: "Star or unstar an email.",
	snooze_email: "Snooze a received inbox email until a future time, when it returns to Inbox, or pass until: null to unsnooze it now.",
	move_to_folder: "Move up to 20 received emails into a custom folder, or pass folderId: null to take them out of their folder and back to Inbox.",
	search_contacts: "Find saved contacts by name or address. Returns only people who have mail in the mailboxes this key can read.",
};

type McpMailContext = { env: CloudflareEnv; user: SessionUser; mailboxIds: string[] };

async function requireMailbox(context: McpMailContext, mailboxId: string, manage = false) {
	const access = context.mailboxIds.includes(mailboxId) ? await getMailboxAccessLevel(getDb(context.env), context.user, mailboxId) : null;
	if (!access?.canRead || (manage && !access.canManage)) throw new Error("Mailbox not found or permission denied");
}

async function mailboxMessages(context: McpMailContext, mailboxId: string, ids: string[]) {
	const rows = await getDb(context.env).select().from(messages).where(and(inArray(messages.id, ids), eq(messages.mailboxId, mailboxId)));
	const visible = rows.filter((row) => row.status !== "draft" || row.userId === context.user.id);
	if (visible.length !== ids.length) throw new Error("Message not found");
	return visible;
}

export async function runMcpMailTool(context: McpMailContext, name: McpMailToolName, rawInput: unknown): Promise<unknown> {
	const db = getDb(context.env);
	if (name === "search_contacts") {
		const input = mcpMailToolSchemas.search_contacts.parse(rawInput);
		if (!context.mailboxIds.length) return { contacts: [] };
		const needle = input.query.toLowerCase();
		const contains = (column: typeof contacts.email | typeof contacts.displayName) => gt(charIndex(sql`lower(${column})`, needle), 0);
		const correspondent = sql`lower(${concatText("%", sql`${contacts.email}`, "%")})`;
		// Contacts belong to the user, not a mailbox; only show people this key could already see in its mailboxes.
		const seen = db.select({ id: messages.id }).from(messages).where(and(
			inArray(messages.mailboxId, context.mailboxIds),
			or(sql`lower(${messages.fromAddr}) like ${correspondent}`, sql`lower(${messages.toAddr}) like ${correspondent}`, sql`lower(${messages.ccAddr}) like ${correspondent}`),
		));
		const rows = await db.select({ email: contacts.email, displayName: contacts.displayName, blocked: contacts.blocked, lastSeenAt: contacts.lastSeenAt })
			.from(contacts)
			.where(and(eq(contacts.userId, context.user.id), or(contains(contacts.email), contains(contacts.displayName)), exists(seen)))
			.orderBy(desc(contacts.lastSeenAt), asc(contacts.email))
			.limit(input.limit);
		return { contacts: rows.map((row) => ({ email: row.email, name: row.displayName, blocked: row.blocked, lastSeenAt: row.lastSeenAt })) };
	}
	if (name === "list_folders") {
		const { mailboxId } = mcpMailToolSchemas.list_folders.parse(rawInput);
		await requireMailbox(context, mailboxId);
		const rows = await db.select({ id: folders.id, name: folders.name, color: folders.color }).from(folders).where(eq(folders.mailboxId, mailboxId)).orderBy(asc(folders.name));
		return { folders: rows };
	}
	if (name === "star_email") {
		const input = mcpMailToolSchemas.star_email.parse(rawInput);
		await requireMailbox(context, input.mailboxId);
		const [row] = await mailboxMessages(context, input.mailboxId, [input.emailId]);
		await db.update(messages).set({ starred: input.starred }).where(eq(messages.id, row.id));
		return { emailId: row.id, starred: input.starred };
	}
	if (name === "snooze_email") {
		const input = mcpMailToolSchemas.snooze_email.parse(rawInput);
		await requireMailbox(context, input.mailboxId, true);
		const [row] = await mailboxMessages(context, input.mailboxId, [input.emailId]);
		if (row.direction !== "inbound" || row.status !== "received" || row.folderId) throw new Error("Only received emails in Inbox can be snoozed");
		const until = input.until === null ? null : parseSnoozeUntil(input.until);
		if (until === undefined) throw new Error("Choose a future snooze time as ISO 8601 with a timezone offset");
		await db.update(messages).set({ snoozedUntil: until }).where(eq(messages.id, row.id));
		return { emailId: row.id, snoozedUntil: until?.toISOString() ?? null };
	}
	if (name === "move_to_folder") {
		const input = mcpMailToolSchemas.move_to_folder.parse(rawInput);
		await requireMailbox(context, input.mailboxId, true);
		const ids = [...new Set(input.emailIds)];
		const rows = await mailboxMessages(context, input.mailboxId, ids);
		if (rows.some((row) => row.direction !== "inbound" || row.status === "draft")) throw new Error("Only received emails can be moved to a folder");
		if (input.folderId) {
			const [folder] = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.id, input.folderId), eq(folders.mailboxId, input.mailboxId))).limit(1);
			if (!folder) throw new Error("Folder not found");
		}
		// Spam keeps its own training path; moving it out goes through move_email with destination inbox.
		if (rows.some((row) => row.status === "spam")) throw new Error("Move spam to Inbox with move_email first");
		await db.update(messages).set({ status: "received", folderId: input.folderId, snoozedUntil: null }).where(inArray(messages.id, ids));
		await Promise.all(ids.map((messageId) => createAuditLog(context.env, { actorUserId: context.user.id, mailboxId: input.mailboxId, messageId, action: "email.delete", metadata: { folderId: input.folderId, origin: "mcp" } })));
		return { emailIds: ids, folderId: input.folderId };
	}
	throw new Error("Unknown tool");
}

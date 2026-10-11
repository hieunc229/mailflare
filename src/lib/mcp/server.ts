import { eq } from "drizzle-orm";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/db";
import { agentSendApprovals, messages } from "@/db/schema";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { runEmailTool, EMAIL_TOOL_NAMES, emailToolDescriptions, emailToolSchemas } from "@/lib/agent/tools";
import { editAgentDraft } from "@/lib/agent/edit-draft";
import { requestAgentSend, getAgentSendRequest } from "@/lib/agent/approvals/utils";
import { cancelScheduledSend, getScheduledTime } from "@/lib/email/scheduled";
import type { EmailToolName } from "@/lib/agent/types";
import type { McpPrincipal } from "./types";
import { registerAdminMcpTools } from "./admin-tools";
import { CALENDAR_TOOL_NAMES, calendarToolDescriptions, calendarToolSchemas, calendarToolScope, runCalendarTool } from "@/lib/calendar/tools";

const scopeByTool: Record<EmailToolName, string> = {
	list_emails: "mcp:read", get_email: "mcp:read", get_thread: "mcp:read", search_emails: "mcp:read",
	draft_email: "mcp:draft", draft_reply: "mcp:draft", edit_draft: "mcp:draft", review_draft_send: "mcp:request-send", mark_email_read: "mcp:organize", move_email: "mcp:organize", move_emails: "mcp:organize", discard_draft: "mcp:draft",
};

function output(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

export function createMailflareMcpHandler(env: CloudflareEnv, principal: McpPrincipal, baseUrl: string, authorization: string) {
	return createMcpHandler(() => {
		const server = new McpServer({ name: "mailflare", version: "0.1.0" });
		if (principal.scopes.some((scope) => scope.startsWith("mcp:"))) {
		for (const name of CALENDAR_TOOL_NAMES) {
			server.registerTool(name, { description: calendarToolDescriptions[name], inputSchema: calendarToolSchemas[name] }, async (args) => {
				if (!principal.scopes.includes(calendarToolScope(name))) return output({ error: "Permission denied" }, true);
				try { return output(await runCalendarTool({ env, user: principal.user }, name, args)); }
				catch (error) { return output({ error: error instanceof Error ? error.message : "Calendar tool failed" }, true); }
			});
		}
		server.registerTool("list_mailboxes", { description: "List mailboxes allowed for this key", inputSchema: z.object({}) }, async () => {
			if (!principal.scopes.includes("mcp:read")) return output({ error: "Permission denied" }, true);
			const accessible = await listAccessibleMailboxes(getDb(env), principal.user);
			return output(accessible.filter((row) => principal.mailboxIds.includes(row.id)).map(({ id, localPart, hostname, displayName }) => ({ id, address: `${localPart}@${hostname}`, displayName })));
		});
		for (const name of EMAIL_TOOL_NAMES) {
			if (name === "edit_draft" || name === "review_draft_send") continue;
			server.registerTool(name, { description: emailToolDescriptions[name], inputSchema: z.object({ mailboxId: z.string().min(1), ...emailToolSchemas[name].shape }) }, async (args) => {
				if (!principal.scopes.includes(scopeByTool[name]) || !principal.mailboxIds.includes(args.mailboxId)) return output({ error: "Permission denied" }, true);
				try { return output(await runEmailTool({ env, user: principal.user, mailboxId: args.mailboxId, origin: "mcp" }, name, args)); }
				catch (error) { return output({ error: error instanceof Error ? error.message : "Tool failed" }, true); }
			});
		}
		server.registerTool("update_draft", { description: emailToolDescriptions.edit_draft, inputSchema: z.object({ mailboxId: z.string(), ...emailToolSchemas.edit_draft.shape }) }, async (args) => {
			const { mailboxId } = args;
			if (!principal.scopes.includes("mcp:draft") || !principal.mailboxIds.includes(mailboxId)) return output({ error: "Permission denied" }, true);
			try { return output(await editAgentDraft({ env, user: principal.user, mailboxId, origin: "mcp" }, args)); }
			catch (error) { return output({ error: error instanceof Error ? error.message : "Draft update failed" }, true); }
		});
		server.registerTool("request_send", { description: "Request human review of a draft; this never sends", inputSchema: z.object({ mailboxId: z.string(), draftId: z.string(), expectedRevision: z.number().int().positive() }) }, async ({ mailboxId, draftId, expectedRevision }) => {
			if (!principal.scopes.includes("mcp:request-send") || !principal.mailboxIds.includes(mailboxId)) return output({ error: "Permission denied" }, true);
			const [draft] = await getDb(env).select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, draftId)).limit(1);
			if (draft?.mailboxId !== mailboxId) return output({ error: "Draft not found" }, true);
			try {
				const result = await requestAgentSend(env, principal.user, draftId, expectedRevision, principal.keyId);
				return output({ ...result, reviewUrl: new URL(result.reviewUrl, env.APP_URL || baseUrl).toString() });
			}
			catch (error) { return output({ error: error instanceof Error ? error.message : "Request failed" }, true); }
		});
		server.registerTool("get_scheduled_send", { description: "Get when a scheduled email (from the scheduled folder) will be sent.", inputSchema: z.object({ mailboxId: z.string(), messageId: z.string() }) }, async ({ mailboxId, messageId }) => {
			if (!principal.scopes.includes("mcp:read") || !principal.mailboxIds.includes(mailboxId)) return output({ error: "Permission denied" }, true);
			const db = getDb(env);
			const [row] = await db.select({ mailboxId: messages.mailboxId, status: messages.status }).from(messages).where(eq(messages.id, messageId)).limit(1);
			const scheduledAt = row?.mailboxId === mailboxId && row.status === "queued" ? await getScheduledTime(db, messageId) : null;
			return scheduledAt ? output({ messageId, scheduledAt: scheduledAt.toISOString() }) : output({ error: "Scheduled email not found" }, true);
		});
		server.registerTool("cancel_scheduled_send", { description: "Cancel a scheduled email before it is sent. It returns to Drafts and is not sent.", inputSchema: z.object({ mailboxId: z.string(), messageId: z.string() }) }, async ({ mailboxId, messageId }) => {
			if (!principal.scopes.includes("mcp:draft") || !principal.mailboxIds.includes(mailboxId)) return output({ error: "Permission denied" }, true);
			const db = getDb(env);
			const [row] = await db.select({ mailboxId: messages.mailboxId, status: messages.status }).from(messages).where(eq(messages.id, messageId)).limit(1);
			if (row?.mailboxId !== mailboxId || row.status !== "queued") return output({ error: "Scheduled email not found" }, true);
			return await cancelScheduledSend(db, messageId)
				? output({ messageId, status: "cancelled", draftId: messageId })
				: output({ error: "This email is already being sent" }, true);
		});
		server.registerTool("get_send_request", { description: "Read the status of this key's send review request", inputSchema: z.object({ approvalId: z.string() }) }, async ({ approvalId }) => {
			if (!principal.scopes.includes("mcp:request-send")) return output({ error: "Permission denied" }, true);
			const [row] = await getDb(env).select({ keyId: agentSendApprovals.requestKeyId }).from(agentSendApprovals).where(eq(agentSendApprovals.id, approvalId)).limit(1);
			if (row?.keyId !== principal.keyId) return output({ error: "Request not found" }, true);
			try { return output(await getAgentSendRequest(env, principal.user, approvalId)); }
			catch { return output({ error: "Request not found" }, true); }
		});
		}
		registerAdminMcpTools(server, principal, baseUrl, authorization);
		return server;
	}, { responseMode: "json" });
}

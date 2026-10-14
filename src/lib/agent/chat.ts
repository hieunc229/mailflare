import { and, asc, desc, eq } from "drizzle-orm";
import { streamText, stepCountIs } from "ai";
import { getDb } from "@/db";
import { agentChatMessages, agentConversations, mailboxAgentSettings, messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { agentCurrentEmailContext, agentSystemPrompt, getAgentModel } from "./model";
import { agentProviderErrorMessage } from "./errors";
import { getAgentEnabled } from "./provider";
import { recordAiUsage } from "@/lib/ai/usage";
import { EMAIL_TOOL_NAMES, emailToolDescriptions, emailToolSchemas, runEmailTool } from "./tools";
import type { AgentToolContext } from "./types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { CALENDAR_TOOL_NAMES, calendarToolDescriptions, calendarToolSchemas, runCalendarTool } from "@/lib/calendar/tools";

export async function getAgentConversation(context: AgentToolContext, conversationId: string) {
	const db = getDb(context.env);
	const [conversation] = await db.select().from(agentConversations).where(and(eq(agentConversations.id, conversationId), eq(agentConversations.userId, context.user.id), eq(agentConversations.mailboxId, context.mailboxId))).limit(1);
	return conversation ?? null;
}

export async function listAgentConversations(context: AgentToolContext) {
	const db = getDb(context.env);
	const access = await getMailboxAccessLevel(db, context.user, context.mailboxId);
	if (!access?.canRead) throw new Error("Mailbox not found");
	return db.select().from(agentConversations).where(and(eq(agentConversations.userId, context.user.id), eq(agentConversations.mailboxId, context.mailboxId))).orderBy(desc(agentConversations.updatedAt)).limit(30);
}

export async function getAgentChatHistory(context: AgentToolContext, conversationId: string) {
	if (!await getAgentConversation(context, conversationId)) throw new Error("Conversation not found");
	return getDb(context.env).select().from(agentChatMessages).where(eq(agentChatMessages.conversationId, conversationId)).orderBy(asc(agentChatMessages.createdAt)).limit(200);
}

export async function createAgentChatStream(context: AgentToolContext, text: string, conversationId?: string, signal?: AbortSignal, timeZone?: string, currentMessageId?: string) {
	timeZone = normalizeTimeZone(timeZone ?? context.timeZone);
	context = { ...context, timeZone };
	const db = getDb(context.env);
	const access = await getMailboxAccessLevel(db, context.user, context.mailboxId);
	if (!access?.canRead) throw new Error("Mailbox not found");
	if (!await getAgentEnabled(context.env)) throw new Error("Assistant is disabled");
	const [settings] = await db.select().from(mailboxAgentSettings).where(eq(mailboxAgentSettings.mailboxId, context.mailboxId)).limit(1);
	const selection = await getAgentModel(context.env, settings?.modelId);
	if (!selection) throw new Error("AI provider is not configured");
	// Ignored unless it is in this mailbox and visible to the user, matching get_email.
	const [current] = currentMessageId ? await db.select({ id: messages.id, status: messages.status, userId: messages.userId }).from(messages).where(and(eq(messages.id, currentMessageId), eq(messages.mailboxId, context.mailboxId))).limit(1) : [];
	const openEmailId = current && (current.status !== "draft" || current.userId === context.user.id) ? current.id : null;
	let conversation = conversationId ? await getAgentConversation(context, conversationId) : null;
	if (conversationId && !conversation) throw new Error("Conversation not found");
	if (!conversation) {
		const id = newId("conv");
		await db.insert(agentConversations).values({ id, userId: context.user.id, mailboxId: context.mailboxId, title: text.slice(0, 80) });
		conversation = await getAgentConversation(context, id);
	}
	if (!conversation) throw new Error("Cannot create conversation");
	const history = await db.select().from(agentChatMessages).where(eq(agentChatMessages.conversationId, conversation.id)).orderBy(desc(agentChatMessages.createdAt)).limit(30);
	await db.insert(agentChatMessages).values({ id: newId("chat"), conversationId: conversation.id, role: "user", content: text });
	const prompt = history.reverse().filter((row) => row.role === "user" || row.role === "assistant").map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));
	// Sent with the latest turn rather than the system prompt so it outweighs emails named earlier in the history; never stored.
	prompt.push({ role: "user", content: openEmailId ? `${text}\n\n(${agentCurrentEmailContext(openEmailId)})` : text });	const tools = Object.fromEntries(EMAIL_TOOL_NAMES.map((name) => [name, {
		description: emailToolDescriptions[name], inputSchema: emailToolSchemas[name],
		execute: async (input: unknown) => runEmailTool(context, name, input),
	}]));
	const calendarTools = Object.fromEntries(CALENDAR_TOOL_NAMES.map((name) => [name, {
		description: calendarToolDescriptions[name], inputSchema: calendarToolSchemas[name],
		execute: async (input: unknown) => runCalendarTool(context, name, input),
	}]));
	const result = streamText({ model: selection.model, system: agentSystemPrompt(settings?.instructions ?? "", timeZone), messages: prompt, tools: { ...tools, ...calendarTools }, stopWhen: stepCountIs(7), maxOutputTokens: 1200, abortSignal: signal, onStepFinish: async ({ usage }) => { await recordAiUsage({ env: context.env, details: selection, usage, source: "chat" }); } });
	const encoder = new TextEncoder();
	const id = conversation.id;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let response = "";
			let stepText = "";
			let reasoning = "";
			const emit = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			emit({ type: "conversation", conversationId: id });
			try {
				for await (const part of result.fullStream) {
					if (part.type === "text-delta") {
						response += part.text;
						stepText += part.text;
						emit({ type: "text", text: part.text });
					} else if (part.type === "reasoning-delta") {
						reasoning += part.text;
						emit({ type: "reasoning", text: part.text });
					} else if (part.type === "finish-step") {
						if (part.finishReason === "tool-calls" && stepText) {
							response = response.slice(0, -stepText.length);
							reasoning += stepText;
							emit({ type: "reclassify", text: stepText });
						}
						stepText = "";
					} else if (part.type === "tool-call") {
						emit({ type: "tool", id: part.toolCallId, name: part.toolName, state: "running" });
					} else if (part.type === "tool-result") {
						const recordId = newId("chat");
						await db.insert(agentChatMessages).values({ id: recordId, conversationId: id, role: "tool", toolName: part.toolName, content: (JSON.stringify(part.output) ?? "null").slice(0, 12_000) });
						emit({ type: "tool", id: part.toolCallId, name: part.toolName, state: "complete", result: part.output, recordId });
					} else if (part.type === "tool-error") {
						const message = agentProviderErrorMessage(part.error);
						await db.insert(agentChatMessages).values({ id: newId("chat"), conversationId: id, role: "tool", toolName: part.toolName, content: message });
						emit({ type: "tool", id: part.toolCallId, name: part.toolName, state: "failed", result: message });
					} else if (part.type === "error") {
						emit({ type: "error", message: agentProviderErrorMessage(part.error) });
					}
				}
				if (reasoning.trim()) await db.insert(agentChatMessages).values({ id: newId("chat"), conversationId: id, role: "tool", toolName: "__reasoning__", content: reasoning.slice(0, 20_000) });
				if (response.trim()) await db.insert(agentChatMessages).values({ id: newId("chat"), conversationId: id, role: "assistant", content: response });
				await db.update(agentConversations).set({ updatedAt: new Date() }).where(eq(agentConversations.id, id));
				emit({ type: "done" });
			} catch (error) {
				if (reasoning.trim()) await db.insert(agentChatMessages).values({ id: newId("chat"), conversationId: id, role: "tool", toolName: "__reasoning__", content: reasoning.slice(0, 20_000) });
				if (response.trim()) await db.insert(agentChatMessages).values({ id: newId("chat"), conversationId: id, role: "assistant", content: response });
				emit({ type: "error", message: agentProviderErrorMessage(error) });
			} finally {
				controller.close();
			}
		},
	});
	return { conversationId: id, stream };
}

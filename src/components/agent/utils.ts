import type { Translator } from "../../lib/i18n/utils";
import type { KeyboardEvent } from "react";
import type { AgentActionProposal, AgentDraftAction, AgentEmailReference, AgentEvent, AgentMessage, AgentTurn, AgentTurnProps, QueuedAgentMessage } from "./types";

export function enqueueAgentMessage(messages: QueuedAgentMessage[], text: string): QueuedAgentMessage[] {
	return [...messages, { id: crypto.randomUUID(), text: text.trim() }];
}

export function removeQueuedAgentMessage(messages: QueuedAgentMessage[], id: string): QueuedAgentMessage[] {
	return messages.filter((item) => item.id !== id);
}

export function editQueuedAgentMessage(messages: QueuedAgentMessage[], id: string, text: string): QueuedAgentMessage[] {
	return messages.map((item) => item.id === id ? { ...item, text: text.trim() } : item);
}

export function steerQueuedAgentMessage(messages: QueuedAgentMessage[], id: string): QueuedAgentMessage[] {
	const selected = messages.find((item) => item.id === id);
	return selected ? [selected, ...messages.filter((item) => item.id !== id)] : messages;
}

export async function consumeAgentStream(response: Response, onEvent: (event: AgentEvent) => void) {
	if (!response.body) throw new Error("Assistant stream is unavailable");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as AgentEvent);
	}
	if (pending.trim()) onEvent(JSON.parse(pending) as AgentEvent);
}

export function draftFromToolResult(result: unknown): { draftId: string; revision: number } | null {
	if (!result || typeof result !== "object") return null;
	const value = result as { draftId?: unknown; revision?: unknown; status?: unknown };
	return value.status !== "sent" && typeof value.draftId === "string" && typeof value.revision === "number" ? { draftId: value.draftId, revision: value.revision } : null;
}

export function draftFromToolContent(content: string) {
	if (!content.startsWith("{")) return null;
	try { return draftFromToolResult(JSON.parse(content)); }
	catch { return null; }
}

// A message object never changes content (updates replace it), so each tool result is parsed once. Callers only read it.
const parsedTools = new WeakMap<AgentMessage, ReturnType<typeof parseAgentToolContent>>();

export function uniqueAgentDraftActions(messages: AgentMessage[]): AgentDraftAction[] {
	const byDraft = new Map<string, AgentDraftAction>();
	for (const item of messages) {
		if (item.role !== "tool" || item.toolState === "running" || item.toolState === "failed") continue;
		let result = parsedTools.get(item);
		if (result === undefined) {
			result = parseAgentToolContent(item.content);
			parsedTools.set(item, result);
		}
		if (result?.status === "sent" && typeof result.draftId === "string") {
			byDraft.delete(result.draftId);
			continue;
		}
		const draft = result ? draftFromToolResult(result) : null;
		if (!result || !draft) continue;
		const current = byDraft.get(draft.draftId);
		if (current && draft.revision < current.revision) continue;
		const scheduledAt = Object.prototype.hasOwnProperty.call(result, "scheduledAt")
			? (typeof result.scheduledAt === "string" && result.scheduledAt ? result.scheduledAt : null)
			: (current?.scheduledAt ?? null);
		byDraft.set(draft.draftId, { messageId: item.id, draftId: draft.draftId, revision: draft.revision, scheduledAt });
	}
	return [...byDraft.values()];
}

export function markAgentDraftSent(messages: AgentMessage[], draftId: string): AgentMessage[] {
	return messages.map((item) => {
		if (item.role !== "tool") return item;
		const result = parseAgentToolContent(item.content);
		return result?.draftId === draftId ? { ...item, content: JSON.stringify({ ...result, status: "sent" }) } : item;
	});
}

export function readAgentConversationId(mailboxId: string): string | null {
	try { return localStorage.getItem(`mailflare-assistant-conversation:${mailboxId}`); }
	catch { return null; }
}

export function saveAgentConversationId(mailboxId: string, conversationId: string | null) {
	try {
		const key = `mailflare-assistant-conversation:${mailboxId}`;
		if (conversationId) localStorage.setItem(key, conversationId);
		else localStorage.removeItem(key);
	} catch { /* Storage is optional. */ }
}

export function resizeAgentInput(input: HTMLTextAreaElement | null) {
	if (!input) return;
	const style = getComputedStyle(input);
	const lineHeight = parseFloat(style.lineHeight) || 20;
	const spacing = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
	const minHeight = lineHeight + spacing;
	const maxHeight = lineHeight * 4 + spacing;
	if (!input.value) {
		input.style.height = `${minHeight}px`;
		return;
	}
	input.style.height = "auto";
	input.style.height = `${Math.min(maxHeight, Math.max(minHeight, input.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)))}px`;
	input.style.overflowY = input.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) > maxHeight ? "auto" : "hidden";
}

export function isAgentScrollAtBottom(container: HTMLElement): boolean {
	return container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
}

export function shouldSubmitAgentInput(event: KeyboardEvent<HTMLTextAreaElement>) {
	return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing;
}

export function appendAgentReasoning(messages: AgentMessage[], assistantId: string, text: string, reclassify = false): AgentMessage[] {
	const reasoningId = `${assistantId}:reasoning`;
	const existing = messages.some((item) => item.id === reasoningId);
	const updated = messages.map((item) => {
		if (item.id === reasoningId) return { ...item, content: item.content + text };
		if (reclassify && item.id === assistantId && item.content.endsWith(text)) return { ...item, content: item.content.slice(0, -text.length) };
		return item;
	});
	return existing ? updated : [...updated, { id: reasoningId, role: "reasoning", content: text }];
}

export function normalizeAgentHistory(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((item) => item.role === "tool" && item.toolName === "__reasoning__" ? { ...item, role: "reasoning" as const } : item.role === "tool" ? { ...item, recordId: item.id } : item);
}

export function groupAgentMessages(messages: AgentMessage[]): AgentTurn[] {
	const turns: AgentTurn[] = [];
	for (const item of messages) {
		if (item.role === "user" || !turns.length) turns.push({ id: item.id, user: null, assistant: null, activity: [], durationMs: null, running: false });
		const turn = turns[turns.length - 1]!;
		if (item.role === "user") turn.user = item;
		else if (item.role === "assistant" || item.role === "system") turn.assistant = item;
		else turn.activity.push(item);
	}
	for (const turn of turns) {
		turn.running = !!turn.assistant?.pending;
		if (typeof turn.assistant?.durationMs === "number") turn.durationMs = turn.assistant.durationMs;
		else if (turn.user?.createdAt && turn.assistant?.createdAt) {
			const duration = Date.parse(turn.assistant.createdAt) - Date.parse(turn.user.createdAt);
			if (Number.isFinite(duration) && duration >= 0) turn.durationMs = duration;
		}
	}
	return turns;
}

export function formatAgentDuration(durationMs: number): string {
	if (durationMs < 1_000) return "<1s";
	const seconds = Math.round(durationMs / 1_000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export const AGENT_TOOL_NAMES = [
	"list_emails", "get_email", "get_thread", "search_emails", "draft_email", "draft_reply", "mark_email_read", "move_email", "move_emails",
	"discard_draft", "get_schedule", "search_events", "get_event", "create_event", "update_events", "delete_events", "find_free_time", "get_calendars",
] as const;

type AgentToolName = typeof AGENT_TOOL_NAMES[number];

function agentToolText(name: string | null | undefined, part: "running" | "completed" | "description", t: Translator): string | null {
	return (AGENT_TOOL_NAMES as readonly string[]).includes(name ?? "") ? t(`agent.tool.${name as AgentToolName}.${part}`) : null;
}

export function activeAgentTool(messages: AgentMessage[]): AgentMessage | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const item = messages[index]!;
		if (item.role === "user") break;
		if (item.role === "tool" && item.toolState === "running") return item;
	}
	return null;
}

export function activeAgentToolLabel(name: string | null | undefined, t: Translator): string {
	return agentToolText(name, "running", t) ?? t("agent.tool.using");
}

export function agentEmailHref(email: Pick<AgentEmailReference, "id" | "status" | "url">): string {
	if (email.url?.startsWith("/") && !email.url.startsWith("//")) return email.url;
	const folder = email.status === "sent" || email.status === "archived" || email.status === "trash" || email.status === "spam" || email.status === "draft" ? email.status === "draft" ? "drafts" : email.status : "inbox";
	return `/${folder}/${encodeURIComponent(email.id)}`;
}

export function agentDraftIdFromHref(href: string | null | undefined): string | null {
	const match = /^\/drafts\/([^/?#]+)\/?(?:[?#].*)?$/.exec(href ?? "");
	if (!match) return null;
	try { return decodeURIComponent(match[1]); }
	catch { return null; }
}

export function agentDraftIdForEmail(email: Pick<AgentEmailReference, "id" | "status" | "url">): string | null {
	return email.status === "draft" ? email.id : agentDraftIdFromHref(email.url);
}

export function parseAgentToolContent(content: string): Record<string, unknown> | null {
	if (!content.startsWith("{")) return null;
	try { const result: unknown = JSON.parse(content); return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null; }
	catch { return null; }
}

export function agentActionProposal(content: string): AgentActionProposal | null {
	const value = parseAgentToolContent(content);
	return value && (value.action === "move_email" || value.action === "move_emails" || value.action === "mark_email_read" || value.action === "discard_draft") && (value.status === "pending_approval" || value.status === "processing" || value.status === "approved") ? value as AgentActionProposal : null;
}

export function agentToolLabel(name: string | null | undefined, state: AgentMessage["toolState"], content: string, t: Translator): { label: string; description: string } {
	const fallback = (name ?? "Tool").replace(/_/g, " ");
	const description = agentToolText(name, "description", t);
	if (description === null) return { label: fallback.charAt(0).toUpperCase() + fallback.slice(1), description: t("agent.tool.fallbackDescription") };
	if (state === "running") return { label: agentToolText(name, "running", t)!, description };
	const result = parseAgentToolContent(content);
	const emails = Array.isArray(result?.emails) ? result.emails.length : typeof result?.id === "string" || typeof result?.emailId === "string" ? 1 : null;
	if ((name === "search_emails" || name === "list_emails") && emails !== null) return { label: t(name === "search_emails" ? "agent.tool.searchedCount" : "agent.tool.listedCount", { count: emails }), description };
	if (name === "get_thread" && emails !== null) return { label: t("agent.tool.threadCount", { count: emails }), description };
	if ((name === "move_emails" || name === "move_email") && emails !== null) return { label: t(result?.status === "approved" ? "agent.tool.movedCount" : "agent.tool.preparedCount", { count: emails }), description };
	return { label: agentToolText(name, "completed", t)!, description };
}

/**
 * Whether a memoised turn can skip re-rendering. Messages are replaced, never mutated, so identity is enough;
 * handler props are ignored because the panel passes stable wrappers that read the latest functions.
 */
export function agentTurnPropsEqual(previous: AgentTurnProps, next: AgentTurnProps): boolean {
	const a = previous.turn;
	const b = next.turn;
	if (a.id !== b.id || a.running !== b.running || a.durationMs !== b.durationMs || a.user !== b.user || a.assistant !== b.assistant) return false;
	if (a.activity.length !== b.activity.length || a.activity.some((item, index) => item !== b.activity[index])) return false;
	if (previous.approvingId !== next.approvingId) return false;
	const own = (props: AgentTurnProps) => props.draftActions.filter((action) => props.turn.activity.some((item) => item.id === action.messageId));
	const before = own(previous);
	const after = own(next);
	return before.length === after.length && before.every((action, index) => {
		const other = after[index];
		return action.messageId === other.messageId && action.draftId === other.draftId && action.revision === other.revision && action.scheduledAt === other.scheduledAt;
	});
}

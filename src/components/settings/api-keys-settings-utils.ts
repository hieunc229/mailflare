import type { TranslationKey } from "@/lib/i18n/types";
import { authFetch } from "@/lib/auth/client";
import type { ApiKeyScope } from "@/lib/api/scopes";
import type { ManagedApiKey, McpKeyScope } from "./api-keys-settings-types";

export const MCP_KEY_SCOPES: { value: McpKeyScope; labelKey: TranslationKey; descriptionKey: TranslationKey }[] = [
	{ value: "mcp:read", labelKey: "apiKeys.mcpRead.label", descriptionKey: "apiKeys.mcpRead.description" },
	{ value: "mcp:note", labelKey: "apiKeys.mcpNote.label", descriptionKey: "apiKeys.mcpNote.description" },
	{ value: "mcp:draft", labelKey: "apiKeys.mcpDraft.label", descriptionKey: "apiKeys.mcpDraft.description" },
	{ value: "mcp:organize", labelKey: "apiKeys.mcpOrganize.label", descriptionKey: "apiKeys.mcpOrganize.description" },
	{ value: "mcp:request-send", labelKey: "apiKeys.mcpRequestSend.label", descriptionKey: "apiKeys.mcpRequestSend.description" },
	{ value: "mcp:calendar-read", labelKey: "apiKeys.mcpCalendarRead.label", descriptionKey: "apiKeys.mcpCalendarRead.description" },
	{ value: "mcp:calendar-write", labelKey: "apiKeys.mcpCalendarWrite.label", descriptionKey: "apiKeys.mcpCalendarWrite.description" },
];

export const STANDARD_KEY_SCOPES: { value: ApiKeyScope; labelKey: TranslationKey; descriptionKey: TranslationKey }[] = [
	{ value: "read", labelKey: "apiKeys.read.label", descriptionKey: "apiKeys.read.description" },
	{ value: "send", labelKey: "apiKeys.send.label", descriptionKey: "apiKeys.send.description" },
	{ value: "calendar:read", labelKey: "apiKeys.calendarRead.label", descriptionKey: "apiKeys.calendarRead.description" },
	{ value: "calendar:write", labelKey: "apiKeys.calendarWrite.label", descriptionKey: "apiKeys.calendarWrite.description" },
];

async function responseData(response: Response): Promise<{ error?: unknown; key?: string; apiKeys?: ManagedApiKey[] }> {
	return response.json().catch(() => ({})) as Promise<{ error?: unknown; key?: string; apiKeys?: ManagedApiKey[] }>;
}

export function keyPermissions(key: ManagedApiKey): string[] {
	try {
		const scopes: unknown = JSON.parse(key.scopes);
		return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
	} catch {
		return [];
	}
}

export async function loadManagedApiKeys(): Promise<ManagedApiKey[]> {
	const response = await authFetch("/api/api-keys");
	const data = await responseData(response);
	if (!response.ok || !data.apiKeys) throw new Error(typeof data.error === "string" ? data.error : "Could not load API keys");
	return data.apiKeys;
}

export async function createManagedApiKey(input: { name: string; mcpAllowed: boolean; scopes: ApiKeyScope[] | McpKeyScope[]; mailboxIds: string[] }): Promise<string> {
	const response = await authFetch(input.mcpAllowed ? "/api/agent/mcp-keys" : "/api/api-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: input.name, scopes: input.scopes, mailboxIds: input.mailboxIds }),
	});
	const data = await responseData(response);
	if (!response.ok || !data.key) throw new Error(typeof data.error === "string" ? data.error : "Could not create API key");
	return data.key;
}

export async function revokeManagedApiKey(id: string): Promise<void> {
	const response = await authFetch(`/api/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) {
		const data = await responseData(response);
		throw new Error(typeof data.error === "string" ? data.error : "Could not revoke API key");
	}
}

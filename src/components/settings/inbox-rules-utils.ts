import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import { authFetch } from "@/lib/auth/client";
import { getMailboxFolders } from "@/lib/folders/client";
import type { InboxRule, InboxRuleInput, InboxRulesResponse, RuleFoldersResponse } from "./inbox-rules-types";

export async function fetchInboxRules(mailboxId: string): Promise<InboxRulesResponse> {
	const params = new URLSearchParams({ mailboxId });
	const response = await authFetch(`/api/routing-rules?${params.toString()}`);
	return (await response.json()) as InboxRulesResponse;
}

export async function fetchRuleFolders(mailboxId: string): Promise<RuleFoldersResponse> {
	return getMailboxFolders<RuleFoldersResponse>(mailboxId);
}

export async function createInboxRule(input: InboxRuleInput) {
	const response = await authFetch("/api/routing-rules", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Failed to create rule");
	return data;
}

export async function updateInboxRule(ruleId: string, input: InboxRuleInput) {
	const response = await authFetch(`/api/routing-rules/${ruleId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Failed to update rule");
	return data;
}

export async function deleteInboxRule(ruleId: string) {
	const response = await authFetch(`/api/routing-rules/${ruleId}`, {
		method: "DELETE",
	});
	if (!response.ok) throw new Error("Failed to delete rule");
}

export function getRuleFieldLabel(field: string, t: Translator = defaultTranslator): string {
	if (field === "content") return t("rules.field.content");
	if (field === "title") return t("rules.field.title");
	return t("rules.field.email");
}

export function getRuleOperatorLabel(operator: string, t: Translator = defaultTranslator): string {
	return operator === "exact" ? t("rules.operator.exact") : t("rules.operator.contains");
}

export function getInboxRuleDestination(rule: Pick<InboxRule, "action" | "folderId">): string {
	if (rule.action === "spam" || rule.action === "trash" || rule.action === "forward") return rule.action;
	return rule.folderId ? `folder:${rule.folderId}` : "";
}

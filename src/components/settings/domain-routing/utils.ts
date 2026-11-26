import { requestError } from "@/lib/http/client-error";
import type { TranslationKey } from "@/lib/i18n/types";
import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import { authFetch } from "@/lib/auth/client";
import { ruleErrorMessage } from "@/lib/email/mail-type-rule";
import { formatUserDate } from "@/lib/time/utils";
import type {
	DomainRule,
	DomainRuleField,
	DomainRuleInput,
	DomainRuleMailbox,
	DomainRuleOperator,
} from "./types";

export const MATCH_FIELD_LABELS: Record<DomainRuleField, TranslationKey> = {
	recipient: "routing.field.recipient",
	sender: "routing.field.sender",
	title: "routing.field.title",
	content: "routing.field.content",
	mail_type: "rules.field.mailType",
};

export const MATCH_OPERATOR_LABELS: Record<DomainRuleOperator, TranslationKey> = {
	contains: "routing.operator.contains",
	exact: "routing.operator.exact",
	starts_with: "routing.operator.starts_with",
	ends_with: "routing.operator.ends_with",
	regex: "routing.operator.regex",
};

export const ACTION_LABELS = {
	store: "routing.action.store",
	forward: "routing.action.forward",
	reject: "routing.action.reject",
} satisfies Record<DomainRule["action"], TranslationKey>;

async function readJson<T>(res: Response): Promise<T> {
	const json = (await res.json()) as T & { error?: unknown; code?: unknown };
	if (!res.ok) {
		throw requestError({ error: ruleErrorMessage(json.error, defaultTranslator("routing.requestFailed")), code: json.code }, defaultTranslator("routing.requestFailed"));
	}
	return json;
}

export async function fetchDomainRules(
	domainId: string,
	mailboxId?: string,
): Promise<{ rules: DomainRule[]; mailboxes: DomainRuleMailbox[] }> {
	const params = new URLSearchParams({ domainId });
	if (mailboxId) params.set("mailboxId", mailboxId);
	const res = await authFetch(`/api/routing-rules/domain?${params}`);
	const json = await readJson<{ rules: DomainRule[]; mailboxes: DomainRuleMailbox[] }>(res);
	return { rules: json.rules ?? [], mailboxes: json.mailboxes ?? [] };
}


function domainRuleUrl(id: string | null, mailboxId?: string): string {
	const params = new URLSearchParams();
	if (mailboxId) params.set("mailboxId", mailboxId);
	const queryString = params.toString();
	const query = queryString ? `?${queryString}` : "";
	return `/api/routing-rules/domain${id ? `/${id}` : ""}${query}`;
}

export async function createDomainRule(input: DomainRuleInput, mailboxId?: string) {
	return readJson(
		await authFetch(domainRuleUrl(null, mailboxId), {
			method: "POST",
			// A 401 means "confirm it is you", not "signed out": the screen opens the step-up dialog.
			redirectOnUnauthorized: false,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
}

export async function updateDomainRule(id: string, input: DomainRuleInput, mailboxId?: string) {
	return readJson(
		await authFetch(domainRuleUrl(id, mailboxId), {
			method: "PATCH",
			redirectOnUnauthorized: false,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
}

export async function deleteDomainRule(id: string, mailboxId?: string) {
	return readJson(await authFetch(domainRuleUrl(id, mailboxId), { method: "DELETE" }));
}

export function describeRule(rule: DomainRule, mailboxes: DomainRuleMailbox[], hostname: string, t: Translator = defaultTranslator): string {
	const condition =
		rule.matchField === "mail_type"
			? t("rules.field.mailType")
			: rule.matchValue === "*"
			? t("routing.anyMessage")
			: `${t(MATCH_FIELD_LABELS[rule.matchField])} ${t(MATCH_OPERATOR_LABELS[rule.matchOperator])} "${rule.matchValue}"`;

	if (rule.action === "reject") return t("routing.describe.reject", { condition });
	if (rule.action === "forward") {
		return t(rule.keepCopy ? "routing.describe.forwardCopy" : "routing.describe.forward", { condition, to: rule.forwardTo ?? "—" });
	}
	const mailbox = mailboxes.find((m) => m.id === rule.mailboxId);
	const address = mailbox ? `${mailbox.localPart}@${hostname}` : "—";
	return t("routing.describe.store", { condition, address });
}

export function formatLastMatched(value: DomainRule["lastMatchedAt"], t: Translator = defaultTranslator): string {
	if (value === null || value === undefined) return t("routing.never");
	const numeric = typeof value === "number" ? value : Date.parse(String(value));
	if (!Number.isFinite(numeric)) return t("routing.never");
	// Drizzle timestamps serialise as seconds when they bypass the mapper.
	const ms = numeric < 1e12 ? numeric * 1000 : numeric;
	return formatUserDate(new Date(ms), { dateStyle: "medium", timeStyle: "short" });
}

export function emptyRuleInput(domainId: string): DomainRuleInput {
	return {
		domainId,
		name: "",
		enabled: true,
		matchField: "recipient",
		matchOperator: "contains",
		matchValue: "",
		action: "store",
		mailboxId: null,
		forwardTo: "",
		keepCopy: false,
		rejectReason: "",
		priority: 100,
	};
}

export function ruleToInput(rule: DomainRule): DomainRuleInput {
	return {
		domainId: rule.domainId,
		name: rule.name ?? "",
		enabled: rule.enabled,
		matchField: rule.matchField,
		matchOperator: rule.matchOperator,
		matchValue: rule.matchValue,
		action: rule.action,
		mailboxId: rule.mailboxId,
		forwardTo: rule.forwardTo ?? "",
		keepCopy: rule.keepCopy,
		rejectReason: rule.rejectReason ?? "",
		priority: rule.priority,
	};
}

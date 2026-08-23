import { eq, and, desc } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, folders, mailboxes, routingRules } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { parseAddress } from "@/lib/utils";

export type ResolvedMailbox = {
	mailboxId: string;
	folderId: string | null;
	userId: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
	forwardTo: string | null;
};

export type RoutingDecision = {
	action: "store" | "forward" | "reject";
	mailbox?: ResolvedMailbox;
	forwardTo?: string;
};

export type InboxRuleDestination = {
	status: "received" | "spam" | "trash";
	folderId: string | null;
};

export async function resolveInboundAddress(
	db: AppDatabase,
	toAddress: string,
): Promise<RoutingDecision | null> {
	const parsed = parseAddress(toAddress);
	if (!parsed) return null;

	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);

	if (!domain) return null;

	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, parsed.local)))
		.limit(1);

	if (!mailbox) return null;

	return {
		action: "store",
		mailbox: {
			mailboxId: mailbox.id,
			folderId: null,
			userId: mailbox.userId,
			domainId: domain.id,
			localPart: mailbox.localPart,
			hostname: domain.hostname,
			displayName: mailbox.displayName,
			forwardTo: mailbox.forwardTo,
		},
	};
}

/**
 * Looks up just the forwarding address for an inbound recipient, independent
 * of the full store/queue pipeline. Cloudflare's ForwardableEmailMessage.forward()
 * can only be called from within the Worker's email() handler invocation that
 * received the message — not later, from the queue consumer that actually
 * processes it — so this is queried directly from email() before enqueueing.
 */
export async function resolveForwardTarget(
	db: AppDatabase,
	toAddress: string,
): Promise<string | null> {
	const decision = await resolveInboundAddress(db, toAddress);
	return decision?.mailbox?.forwardTo ?? null;
}

export async function resolveInboxRuleDestination(
	db: AppDatabase,
	input: {
		mailboxId: string;
		toAddress: string;
		fromAddress?: string | null;
		subject?: string | null;
		content?: string | null;
	},
): Promise<InboxRuleDestination> {
	const rules = await db
		.select()
		.from(routingRules)
		.where(eq(routingRules.mailboxId, input.mailboxId))
		.orderBy(desc(routingRules.priority));

	for (const rule of rules) {
		if (!matchesInboxRule(rule, input)) continue;

		if (rule.action === "spam" || rule.action === "trash") {
			return { status: rule.action, folderId: null };
		}

		if (!rule.folderId) continue;
		const folderId = await getRuleFolderId(db, rule.folderId, input.mailboxId);
		if (!folderId) continue;
		return { status: "received", folderId };
	}

	return { status: "received", folderId: null };
}

function matchesInboxRule(
	rule: {
		pattern: string;
		matchField?: "email" | "content" | "title" | string;
		matchOperator?: "contains" | "exact" | string;
		matchValue?: string | null;
	},
	input: {
		toAddress: string;
		fromAddress?: string | null;
		subject?: string | null;
		content?: string | null;
	},
): boolean {
	const rawValue = (rule.matchValue || rule.pattern).trim();
	const normalizedRuleValue = normalizeRuleComparisonValue(rule.matchField, rawValue);
	if (!normalizedRuleValue) return false;
	if (normalizedRuleValue === "*") return true;

	const values = getRuleFieldValues(rule.matchField, input);
	return values.some((value) => {
		const normalizedValue = normalizeRuleComparisonValue(rule.matchField, value);
		if (rule.matchOperator === "exact") return normalizedValue === normalizedRuleValue;
		return normalizedValue.includes(normalizedRuleValue);
	});
}

function normalizeRuleComparisonValue(field: string | undefined, value: string | null | undefined): string {
	if (!value) return "";
	if (field !== "email") return value.toLowerCase();
	return getEmailAddress(value).trim().toLowerCase();
}

function getRuleFieldValues(
	field: string | undefined,
	input: {
		toAddress: string;
		fromAddress?: string | null;
		subject?: string | null;
		content?: string | null;
	},
) {
	if (field === "content") return [input.content];
	if (field === "title") return [input.subject];
	return [input.fromAddress, input.toAddress];
}

async function getRuleFolderId(
	db: AppDatabase,
	folderId: string,
	mailboxId: string,
): Promise<string | null> {
	const [folder] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))
		.limit(1);
	return folder?.id ?? null;
}

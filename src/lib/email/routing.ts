import { eq, and, asc, desc } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, folders, mailboxAliases, mailboxes, routingRules } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { toAsciiAddress, toAsciiHostname } from "@/lib/email/idn";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { normalizeRecipientLocalPart, parseRecipientAddress } from "@/lib/email/recipient-address";

export type ResolvedMailbox = {
	mailboxId: string;
	folderId: string | null;
	userId: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
};

export type RoutingDecision = {
	action: "store" | "forward" | "reject";
	mailbox?: ResolvedMailbox;
	forwardTo?: string;
	/** Forward rules drop the message unless the rule also keeps a copy in the mailbox. */
	keepCopy?: boolean;
	rejectReason?: string;
	/** Set when a domain-scope rule produced this decision, so the caller can record a match. */
	ruleId?: string;
};

export type InboxRuleDestination = {
	status: "received" | "spam" | "trash";
	folderId: string | null;
};

type RuleRow = typeof routingRules.$inferSelect;

export type RuleMatchInput = {
	toAddress: string;
	fromAddress?: string | null;
	subject?: string | null;
	content?: string | null;
};

/**
 * Resolves what should happen to an inbound message addressed to `toAddress`.
 *
 * Domain-scope rules are evaluated in three phases so that a broad catch-all can never
 * shadow a real mailbox:
 *   1. `reject` rules (block lists) — highest precedence, evaluated before delivery.
 *   2. exact mailbox, then multi-domain mailbox aliases.
 *   3. remaining `forward` / `store` rules — the catch-all fallback.
 * Within each phase rules run by descending priority, then oldest first.
 */
export async function resolveInboundAddress(
	db: AppDatabase,
	toAddress: string,
	fromAddress?: string | null,
): Promise<RoutingDecision | null> {
	const parsed = parseRecipientAddress(toAddress);
	if (!parsed) return null;

	const [exactDomain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);

	// An internationalised domain is stored as typed (π2.com) but delivered in
	// punycode (xn--2-tmb.com), so fall back to comparing the ASCII forms.
	const domain = exactDomain ?? await resolveDomainByAsciiHostname(db, parsed.domain);

	if (!domain) return null;

	const domainRules = await listDomainRules(db, domain.id);
	const matchInput: RuleMatchInput = { toAddress, fromAddress };

	// Phase 1 — block rules run before any mailbox lookup so they can block a sender
	// even when the recipient is a real mailbox.
	for (const rule of domainRules) {
		if (rule.action !== "reject") continue;
		if (!matchesRule(rule, matchInput)) continue;
		return {
			action: "reject",
			rejectReason: rule.rejectReason?.trim() || "Message rejected by routing rule",
			ruleId: rule.id,
		};
	}

	// Phase 2 — a real mailbox always wins over a catch-all.
	const exactMailboxes = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.disabled, false)));
	const exactMailbox = exactMailboxes.find(
		(mailbox) => normalizeRecipientLocalPart(mailbox.localPart) === parsed.localPart,
	);
	const mailbox = exactMailbox
		?? await resolveMailboxAlias(db, domain.id, parsed.localPart)
		?? await resolveMailboxDomainAlias(db, parsed.localPart, parsed.normalizedAddress);

	if (mailbox) {
		return {
			action: "store",
			mailbox: toResolvedMailbox(mailbox, domain.id, domain.hostname),
		};
	}

	// Phase 3 — catch-all and forwarding fallbacks.
	for (const rule of domainRules) {
		if (rule.action !== "forward" && rule.action !== "store") continue;
		if (!matchesRule(rule, matchInput)) continue;

		if (rule.action === "forward") {
			const forwardTo = rule.forwardTo?.trim();
			if (!forwardTo) continue;
			const catchAll = rule.mailboxId ? await getRuleMailbox(db, rule.mailboxId, domain.id) : null;
			return {
				action: "forward",
				forwardTo,
				keepCopy: rule.keepCopy && !!catchAll,
				mailbox: catchAll ?? undefined,
				ruleId: rule.id,
			};
		}

		if (!rule.mailboxId) continue;
		const catchAll = await getRuleMailbox(db, rule.mailboxId, domain.id);
		if (!catchAll) continue;
		return { action: "store", mailbox: catchAll, ruleId: rule.id };
	}

	return null;
}

async function resolveDomainByAsciiHostname(db: AppDatabase, hostname: string) {
	const ascii = toAsciiHostname(hostname);
	const active = await db.select().from(domains).where(eq(domains.status, "active"));
	return active.find((domain) => toAsciiHostname(domain.hostname) === ascii) ?? null;
}

async function listDomainRules(db: AppDatabase, domainId: string): Promise<RuleRow[]> {
	return db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.domainId, domainId),
				eq(routingRules.scope, "domain"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
}

async function getRuleMailbox(
	db: AppDatabase,
	mailboxId: string,
	domainId: string,
): Promise<ResolvedMailbox | null> {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.disabled, false)))
		.limit(1);
	if (!mailbox) return null;

	const [domain] = await db
		.select({ hostname: domains.hostname })
		.from(domains)
		.where(eq(domains.id, domainId))
		.limit(1);
	if (!domain) return null;

	return toResolvedMailbox(mailbox, domainId, domain.hostname);
}

function toResolvedMailbox(
	mailbox: typeof mailboxes.$inferSelect,
	domainId: string,
	hostname: string,
): ResolvedMailbox {
	return {
		mailboxId: mailbox.id,
		folderId: null,
		userId: mailbox.userId,
		domainId,
		localPart: mailbox.localPart,
		hostname,
		displayName: mailbox.displayName,
	};
}

/** Records that a domain rule fired, for the "last matched" column in the routing UI. */
export async function recordRuleMatch(db: AppDatabase, ruleId: string): Promise<void> {
	const [rule] = await db
		.select({ matchCount: routingRules.matchCount })
		.from(routingRules)
		.where(eq(routingRules.id, ruleId))
		.limit(1);
	if (!rule) return;
	await db
		.update(routingRules)
		.set({ matchCount: rule.matchCount + 1, lastMatchedAt: new Date() })
		.where(eq(routingRules.id, ruleId));
}

async function resolveMailboxAlias(db: AppDatabase, domainId: string, localPart: string) {
	const rows = await db
		.select({ mailbox: mailboxes, aliasLocalPart: mailboxAliases.localPart })
		.from(mailboxAliases)
		.innerJoin(mailboxes, eq(mailboxAliases.mailboxId, mailboxes.id))
		.where(and(
			eq(mailboxAliases.domainId, domainId),
			eq(mailboxes.disabled, false),
		));
	const row = rows.find(
		(item) => normalizeRecipientLocalPart(item.aliasLocalPart) === localPart,
	);
	return row?.mailbox ?? null;
}

async function resolveMailboxDomainAlias(
	db: AppDatabase,
	localPart: string,
	normalizedAddress: string,
) {
	const candidates = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.useAllDomains, true), eq(mailboxes.disabled, false)));

	for (const mailbox of candidates) {
		if (normalizeRecipientLocalPart(mailbox.localPart) !== localPart) continue;
		const addresses = await getMailboxDomainAddresses(db, mailbox);
		// Addresses are built from the stored hostname, so compare on the ASCII form
		// to keep symbol domains matching their delivered punycode spelling.
		const target = toAsciiAddress(normalizedAddress);
		if (addresses.some((address) => {
			const candidate = parseRecipientAddress(address)?.normalizedAddress;
			return !!candidate && toAsciiAddress(candidate) === target;
		})) {
			return mailbox;
		}
	}
	return null;
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
		.where(
			and(
				eq(routingRules.mailboxId, input.mailboxId),
				eq(routingRules.scope, "mailbox"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));

	for (const rule of rules) {
		if (!matchesRule(rule, input)) continue;

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

type MatchableRule = {
	pattern: string;
	matchField?: string | null;
	matchOperator?: string | null;
	matchValue?: string | null;
};

export function matchesRule(rule: MatchableRule, input: RuleMatchInput): boolean {
	const rawValue = (rule.matchValue || rule.pattern).trim();
	// "*" is the catch-all pattern used by catch-all and block-everything rules.
	if (rawValue === "*") return true;
	const normalizedRuleValue = normalizeRuleComparisonValue(rule.matchField, rawValue);
	if (!normalizedRuleValue) return false;

	const values = getRuleFieldValues(rule.matchField, input);
	return values.some((value) => {
		if (!value) return false;
		const normalizedValue = normalizeRuleComparisonValue(rule.matchField, value);
		if (!normalizedValue) return false;
		return compareRuleValue(rule.matchOperator, normalizedValue, normalizedRuleValue, rawValue);
	});
}

function compareRuleValue(
	operator: string | null | undefined,
	value: string,
	ruleValue: string,
	rawRuleValue: string,
): boolean {
	switch (operator) {
		case "exact":
			return value === ruleValue;
		case "starts_with":
			return value.startsWith(ruleValue);
		case "ends_with":
			return value.endsWith(ruleValue);
		case "regex":
			return matchesRegex(value, rawRuleValue);
		default:
			return value.includes(ruleValue);
	}
}

/**
 * Rule patterns are operator-authored but still untrusted enough to warrant guarding:
 * an invalid pattern must not throw and take down inbound processing.
 */
function matchesRegex(value: string, pattern: string): boolean {
	try {
		return new RegExp(pattern, "i").test(value);
	} catch {
		return false;
	}
}

function normalizeRuleComparisonValue(field: string | null | undefined, value: string | null | undefined): string {
	if (!value) return "";
	if (field === "email" || field === "sender" || field === "recipient") {
		return getEmailAddress(value).trim().toLowerCase();
	}
	return value.toLowerCase();
}

function getRuleFieldValues(field: string | null | undefined, input: RuleMatchInput) {
	if (field === "content") return [input.content];
	if (field === "title") return [input.subject];
	if (field === "sender") return [input.fromAddress];
	if (field === "recipient") return [input.toAddress];
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

import { eq, and, asc, desc } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, folders, mailGroups, mailboxAliases, mailboxes, routingRules } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { getEmailAddress } from "@/lib/email/address";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { isBulkMail, type MailHeaders } from "@/lib/email/bulk-mail";
import { MAIL_TYPE_BULK } from "@/lib/email/mail-type-rule";
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

export type ResolvedGroup = {
	groupId: string;
	domainId: string;
	/** Lower-cased `local@hostname` as stored. */
	address: string;
	name: string;
	whoCanPost: "anyone" | "org" | "members";
	replyTo: "sender" | "group";
};

export type RoutingDecision = {
	action: "store" | "forward" | "reject" | "group";
	mailbox?: ResolvedMailbox;
	/** Set when `action` is `group`: the live handler enforces who may post, the queue consumer expands. */
	group?: ResolvedGroup;
	forwardTo?: string;
	/** Forward rules drop the message unless the rule also keeps a copy in the mailbox. */
	keepCopy?: boolean;
	rejectReason?: string;
	/** A reject because the sender may not post to a group, as opposed to a rule or an unavailable group. */
	groupPolicy?: boolean;
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
	/** Message headers, for rules on the `mail_type` field. Without them such a rule never matches. */
	headers?: MailHeaders | null;
};

export type ResolveInboundOptions = {
	/** Message headers, so domain and mailbox-forward rules can match `mail_type`. */
	headers?: MailHeaders | null;
	/**
	 * Apply the mailbox owner's own forwarding rules. Only the receiving handlers set this:
	 * they can still forward the live message, and they know the subject.
	 *
	 * `from` is the From header. Folder, spam and trash rules match the From header, so a
	 * forward rule on the same sender field must match it too, not only the envelope
	 * sender, which bulk senders set to a bounce address the user never sees.
	 */
	mailboxForwards?: { subject?: string | null; from?: string | null };
	/**
	 * Whether group addresses are active (the licence entitlement). Asked only when an address
	 * matches a group. Without it groups are ignored and the address falls through as unknown.
	 */
	allowGroups?: () => Promise<boolean>;
};

/**
 * Resolves what should happen to an inbound message addressed to `toAddress`.
 *
 * Domain-scope rules are evaluated in three phases so that a broad catch-all can never
 * shadow a real mailbox:
 *   1. `reject` rules (block lists) — highest precedence, evaluated before delivery.
 *   2. exact mailbox, then alias, then group, then multi-domain mailbox aliases.
 *   3. remaining `forward` / `store` rules — the catch-all fallback.
 * Within each phase rules run by descending priority, then oldest first.
 */
export async function resolveInboundAddress(
	db: AppDatabase,
	toAddress: string,
	fromAddress?: string | null,
	options: ResolveInboundOptions = {},
): Promise<RoutingDecision | null> {
	const parsed = parseRecipientAddress(toAddress);
	if (!parsed) return null;

	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);

	if (!domain) return null;

	const domainRules = await listDomainRules(db, domain.id);
	const matchInput: RuleMatchInput = { toAddress, fromAddress, headers: options.headers };

	// Phase 1 — block rules run before any mailbox lookup so they can block a sender
	// even when the recipient is a real mailbox.
	for (const rule of domainRules) {
		if (rule.action !== "reject") continue;
		// Backstop: the API refuses this combination; a stored row must never bounce bulk-matched mail.
		if (rule.matchField === "mail_type") continue;
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
	let mailbox = exactMailbox ?? await resolveMailboxAlias(db, domain.id, parsed.localPart);
	// A disabled alias keeps owning its address: reject instead of letting a
	// use-all-domains mailbox or a catch-all rule deliver its mail elsewhere.
	if (!mailbox && await findDisabledAlias(db, domain.id, parsed.localPart)) {
		return { action: "reject", rejectReason: "Mailbox unavailable" };
	}
	if (!mailbox) {
		const group = await resolveGroup(db, domain, parsed.localPart, options.allowGroups);
		if (group === "disabled") return { action: "reject", rejectReason: "Group unavailable" };
		if (group) return { action: "group", group };
	}
	mailbox ??= await resolveMailboxDomainAlias(db, parsed.localPart, parsed.normalizedAddress);

	if (mailbox) {
		const resolved = toResolvedMailbox(mailbox, domain.id, domain.hostname);
		const forward = options.mailboxForwards
			? await findMailboxForward(
				db,
				mailbox.id,
				{ ...matchInput, subject: options.mailboxForwards.subject },
				options.mailboxForwards.from,
			)
			: null;
		if (forward?.forwardTo) {
			return {
				action: "forward",
				forwardTo: forward.forwardTo,
				keepCopy: forward.keepCopy || forward.matchField === "mail_type",
				mailbox: resolved,
				ruleId: forward.id,
			};
		}
		return { action: "store", mailbox: resolved };
	}

	// Phase 3 — catch-all and forwarding fallbacks.
	for (const rule of domainRules) {
		if (rule.action !== "forward" && rule.action !== "store") continue;
		if (!matchesRule(rule, matchInput)) continue;

		if (rule.action === "forward") {
			const forwardTo = rule.forwardTo?.trim();
			if (!forwardTo) continue;
			const catchAll = rule.mailboxId ? await getRuleMailbox(db, rule.mailboxId, domain.id) : null;
			const bulkRule = rule.matchField === "mail_type";
			// Backstop: a mail_type forward always keeps a copy; without a copy target it is skipped.
			if (bulkRule && !catchAll) continue;
			return {
				action: "forward",
				forwardTo,
				keepCopy: (rule.keepCopy || bulkRule) && !!catchAll,
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

/** The group at this address, `"disabled"` when it is switched off, or null (also before the migration, or without the entitlement). */
async function resolveGroup(
	db: AppDatabase,
	domain: { id: string; hostname: string },
	localPart: string,
	allowGroups?: () => Promise<boolean>,
): Promise<ResolvedGroup | "disabled" | null> {
	if (!allowGroups) return null;
	let rows: (typeof mailGroups.$inferSelect)[];
	try {
		rows = await db.select().from(mailGroups).where(eq(mailGroups.domainId, domain.id));
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
	const row = rows.find((item) => normalizeRecipientLocalPart(item.localPart) === localPart);
	if (!row || !(await allowGroups())) return null;
	if (row.disabled) return "disabled";
	return {
		groupId: row.id,
		domainId: domain.id,
		address: `${row.localPart}@${domain.hostname}`.toLowerCase(),
		name: row.name,
		whoCanPost: row.whoCanPost,
		replyTo: row.replyTo,
	};
}

/** The enabled mailbox that receives this address (exact, alias, or use-all-domains), with no rules applied. */
export async function resolveMailboxForAddress(db: AppDatabase, address: string): Promise<typeof mailboxes.$inferSelect | null> {
	const parsed = parseRecipientAddress(address);
	if (!parsed) return null;
	const [domain] = await db
		.select({ id: domains.id })
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);
	if (!domain) return null;
	const candidates = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.disabled, false)));
	const exact = candidates.find((mailbox) => normalizeRecipientLocalPart(mailbox.localPart) === parsed.localPart);
	return exact
		?? await resolveMailboxAlias(db, domain.id, parsed.localPart)
		?? await resolveMailboxDomainAlias(db, parsed.localPart, parsed.normalizedAddress);
}

/**
 * The first enabled forward rule of a mailbox that matches, by descending priority.
 * A sender condition matches either the envelope sender or the From header.
 */
async function findMailboxForward(
	db: AppDatabase,
	mailboxId: string,
	input: RuleMatchInput,
	headerFrom?: string | null,
): Promise<RuleRow | null> {
	const rules = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, mailboxId),
				eq(routingRules.scope, "mailbox"),
				eq(routingRules.action, "forward"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
	return rules.find((rule) => rule.forwardTo?.trim() && matchesForwardRule(rule, input, headerFrom)) ?? null;
}

function matchesForwardRule(
	rule: MatchableRule,
	input: RuleMatchInput,
	headerFrom?: string | null,
): boolean {
	if (matchesRule(rule, input)) return true;
	if (!headerFrom?.trim()) return false;
	return matchesRule(rule, { ...input, fromAddress: headerFrom });
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

export function toResolvedMailbox(
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
			eq(mailboxAliases.enabled, true),
			eq(mailboxes.disabled, false),
		));
	const row = rows.find(
		(item) => normalizeRecipientLocalPart(item.aliasLocalPart) === localPart,
	);
	return row?.mailbox ?? null;
}

async function findDisabledAlias(db: AppDatabase, domainId: string, localPart: string): Promise<boolean> {
	const rows = await db
		.select({ localPart: mailboxAliases.localPart })
		.from(mailboxAliases)
		.where(and(eq(mailboxAliases.domainId, domainId), eq(mailboxAliases.enabled, false)));
	return rows.some((row) => normalizeRecipientLocalPart(row.localPart) === localPart);
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
		if (addresses.some((address) => parseRecipientAddress(address)?.normalizedAddress === normalizedAddress)) {
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
		headers?: MailHeaders | null;
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
		if (rule.action === "forward") continue;
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
	// The condition is the field itself ("is bulk mail"); operator and "*" do not apply.
	if (rule.matchField === "mail_type") {
		return (rule.matchValue || rule.pattern).trim().toLowerCase() === MAIL_TYPE_BULK && isBulkMail(input.headers).bulk;
	}
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

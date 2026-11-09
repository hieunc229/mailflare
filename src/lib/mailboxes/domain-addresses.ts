import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxAliases, mailboxes } from "@/db/schema";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { normalizeRecipientLocalPart, parseRecipientAddress } from "@/lib/email/recipient-address";
import type { MailboxDomainAddressInput } from "./domain-addresses-types";
import type { CfEmailRoutingRuleChange } from "@/lib/cloudflare-api.types";

export async function getMailboxAliasAddresses(
	db: AppDatabase,
	mailboxId: string,
	includeDisabled = false,
): Promise<string[]> {
	const aliases = await db
		.select({ localPart: mailboxAliases.localPart, hostname: domains.hostname })
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(
			includeDisabled
				? eq(mailboxAliases.mailboxId, mailboxId)
				: and(eq(mailboxAliases.mailboxId, mailboxId), eq(mailboxAliases.enabled, true)),
		);
	return aliases.map((alias) => `${alias.localPart}@${alias.hostname}`.toLowerCase());
}

/** The alias row behind an address this mailbox can send as, if any. */
export async function getMailboxAliasForAddress(
	db: AppDatabase,
	mailboxId: string,
	address: string,
	includeDisabled = false,
): Promise<{ label: string | null; masked: boolean; enabled: boolean } | null> {
	const parsed = parseRecipientAddress(address);
	if (!parsed) return null;
	const rows = await db
		.select({
			localPart: mailboxAliases.localPart,
			label: mailboxAliases.label,
			masked: mailboxAliases.masked,
			enabled: mailboxAliases.enabled,
		})
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(and(
			eq(mailboxAliases.mailboxId, mailboxId),
			...(includeDisabled ? [] : [eq(mailboxAliases.enabled, true)]),
			eq(domains.hostname, parsed.domain),
		));
	const row = rows.find((item) => normalizeRecipientLocalPart(item.localPart) === parsed.localPart);
	return row ? { label: row.label, masked: row.masked, enabled: row.enabled } : null;
}

export async function getMailboxDomainAddresses(
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
	includeDisabledAliases = false,
): Promise<string[]> {
	const [primaryDomain] = await db
		.select({ hostname: domains.hostname, userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	if (!primaryDomain) return [];

	const primaryAddress = `${mailbox.localPart}@${primaryDomain.hostname}`.toLowerCase();
	const aliasAddresses = await getMailboxAliasAddresses(db, mailbox.id, includeDisabledAliases);
	if (!mailbox.useAllDomains) {
		return [...new Set([primaryAddress, ...aliasAddresses])];
	}

	const availableDomains = await db
		.select({ id: domains.id, hostname: domains.hostname })
		.from(domains)
		.where(and(eq(domains.userId, primaryDomain.userId), eq(domains.status, "active")));
	const assignedMailboxes = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart })
		.from(mailboxes);
	const assignedAliases = await db
		.select({
			mailboxId: mailboxAliases.mailboxId,
			domainId: mailboxAliases.domainId,
			localPart: mailboxAliases.localPart,
		})
		.from(mailboxAliases);
	const normalizedLocalPart = normalizeRecipientLocalPart(mailbox.localPart);
	const assignedDomainIds = new Set(
		[
			...assignedMailboxes.filter(
				(item) => item.id !== mailbox.id && normalizeRecipientLocalPart(item.localPart) === normalizedLocalPart,
			),
			...assignedAliases.filter(
				(item) => item.mailboxId !== mailbox.id && normalizeRecipientLocalPart(item.localPart) === normalizedLocalPart,
			),
		].map((item) => item.domainId),
	);

	return [
		...new Set([
			primaryAddress,
			...availableDomains
				.filter((domain) => domain.id !== mailbox.domainId && !assignedDomainIds.has(domain.id))
				.map((domain) => `${mailbox.localPart}@${domain.hostname}`.toLowerCase()),
			...aliasAddresses,
		]),
	];
}

export async function ensureMailboxDomainRouting(
	env: CloudflareEnv,
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
	changes?: CfEmailRoutingRuleChange[],
): Promise<void> {
	// Cloudflare rules exist for disabled aliases too: the worker rejects their
	// mail so disabling does not need a routing change, and re-enabling is free.
	const addresses = await getMailboxDomainAddresses(db, mailbox, true);
	if (addresses.length === 0) return;
	const [primaryDomain] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	if (!primaryDomain) return;
	const availableDomains = await db
		.select({ hostname: domains.hostname, zoneId: domains.zoneId, receivingProvider: domains.receivingProvider })
		.from(domains)
		.where(eq(domains.userId, primaryDomain.userId));
	const domainsByHostname = new Map(availableDomains.map((domain) => [domain.hostname.toLowerCase(), domain]));

	// Wait for every request before a caller rolls back a failed attempt.
	const results = await Promise.allSettled(
		addresses.map(async (address) => {
			const hostname = address.slice(address.lastIndexOf("@") + 1);
			const domain = domainsByHostname.get(hostname);
			// Worker routes only matter when Cloudflare is what receives this domain's mail.
			if (domain && domain.receivingProvider === "cloudflare") await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address, changes);
		}),
	);
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
}

export async function removeMailboxDomainRouting(
	env: CloudflareEnv,
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
): Promise<void> {
	// Disabled aliases' rules must come down as well, or mail they own would
	// fall through to a catch-all or use-all-domains mailbox after deletion.
	const addresses = await getMailboxDomainAddresses(db, mailbox, true);
	if (addresses.length === 0) return;
	const [primaryDomain] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	if (!primaryDomain) return;
	const availableDomains = await db
		.select({ hostname: domains.hostname, zoneId: domains.zoneId })
		.from(domains)
		.where(eq(domains.userId, primaryDomain.userId));
	const domainsByHostname = new Map(availableDomains.map((domain) => [domain.hostname.toLowerCase(), domain]));

	await Promise.all(
		addresses.map(async (address) => {
			const hostname = address.slice(address.lastIndexOf("@") + 1);
			const domain = domainsByHostname.get(hostname);
			if (domain) await deleteEmailRoutingRuleForAddress(env, domain.zoneId, address);
		}),
	);
}

import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxAliases, mailboxes } from "@/db/schema";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import type { MailboxDomainAddressInput } from "./domain-addresses-types";
import type { CfEmailRoutingRuleChange } from "@/lib/cloudflare-api.types";

export async function getMailboxAliasAddresses(
	db: AppDatabase,
	mailboxId: string,
): Promise<string[]> {
	const aliases = await db
		.select({ localPart: mailboxAliases.localPart, hostname: domains.hostname })
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(eq(mailboxAliases.mailboxId, mailboxId));
	return aliases.map((alias) => `${alias.localPart}@${alias.hostname}`.toLowerCase());
}

export async function getMailboxDomainAddresses(
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
): Promise<string[]> {
	const [primaryDomain] = await db
		.select({ hostname: domains.hostname, userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	if (!primaryDomain) return [];

	const primaryAddress = `${mailbox.localPart}@${primaryDomain.hostname}`.toLowerCase();
	const aliasAddresses = await getMailboxAliasAddresses(db, mailbox.id);
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
	const addresses = await getMailboxDomainAddresses(db, mailbox);
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

	// Wait for every request before a caller rolls back a failed attempt.
	const results = await Promise.allSettled(
		addresses.map(async (address) => {
			const hostname = address.slice(address.lastIndexOf("@") + 1);
			const domain = domainsByHostname.get(hostname);
			if (domain) await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address, changes);
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
	const addresses = await getMailboxDomainAddresses(db, mailbox);
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

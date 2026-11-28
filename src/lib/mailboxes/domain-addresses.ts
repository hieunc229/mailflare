import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxAliases, mailboxes } from "@/db/schema";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker, type EmailRoutingRuleCache } from "@/lib/cloudflare-api";
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

// D1 allows 100 bound parameters per statement.
const IN_CHUNK = 90;

async function inChunks<T>(ids: string[], query: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
	const rows: T[] = [];
	for (let index = 0; index < ids.length; index += IN_CHUNK) rows.push(...(await query(ids.slice(index, index + IN_CHUNK))));
	return rows;
}

export async function getMailboxDomainAddresses(
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
	includeDisabledAliases = false,
): Promise<string[]> {
	return (await getMailboxesDomainAddresses(db, [mailbox], includeDisabledAliases)).get(mailbox.id) ?? [];
}

/** Sender addresses of many mailboxes in a fixed number of queries; keyed by mailbox id, [] when the primary domain is missing. */
export async function getMailboxesDomainAddresses(
	db: AppDatabase,
	mailboxList: MailboxDomainAddressInput[],
	includeDisabledAliases = false,
): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
	if (!mailboxList.length) return result;
	const primaryIds = [...new Set(mailboxList.map((mailbox) => mailbox.domainId))];
	const primaryDomains = new Map((await inChunks(primaryIds, (chunk) => db
		.select({ id: domains.id, hostname: domains.hostname, userId: domains.userId })
		.from(domains)
		.where(inArray(domains.id, chunk)))).map((domain) => [domain.id, domain]));
	const mailboxIds = mailboxList.map((mailbox) => mailbox.id);
	const aliasRows = await inChunks(mailboxIds, (chunk) => db
		.select({ mailboxId: mailboxAliases.mailboxId, localPart: mailboxAliases.localPart, hostname: domains.hostname })
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(includeDisabledAliases
			? inArray(mailboxAliases.mailboxId, chunk)
			: and(inArray(mailboxAliases.mailboxId, chunk), eq(mailboxAliases.enabled, true))));
	const aliasAddresses = new Map<string, string[]>();
	for (const alias of aliasRows) aliasAddresses.set(alias.mailboxId, [...(aliasAddresses.get(alias.mailboxId) ?? []), `${alias.localPart}@${alias.hostname}`.toLowerCase()]);

	const useAll = mailboxList.filter((mailbox) => mailbox.useAllDomains && primaryDomains.has(mailbox.domainId));
	const ownerIds = [...new Set(useAll.map((mailbox) => (primaryDomains.get(mailbox.domainId) as { userId: string }).userId))];
	const availableByOwner = new Map<string, Array<{ id: string; hostname: string }>>();
	for (const domain of await inChunks(ownerIds, (chunk) => db
		.select({ id: domains.id, hostname: domains.hostname, userId: domains.userId })
		.from(domains)
		.where(and(inArray(domains.userId, chunk), eq(domains.status, "active"))))) {
		availableByOwner.set(domain.userId, [...(availableByOwner.get(domain.userId) ?? []), domain]);
	}
	// Only domains a mailbox can actually be assigned on need the collision check; scanning every
	// tenant's mailboxes made this O(all mailboxes).
	const candidateDomainIds = [...new Set(useAll.flatMap((mailbox) => [mailbox.domainId, ...(availableByOwner.get((primaryDomains.get(mailbox.domainId) as { userId: string }).userId) ?? []).map((domain) => domain.id)]))];
	const assignedMailboxes = await inChunks(candidateDomainIds, (chunk) => db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart })
		.from(mailboxes)
		.where(inArray(mailboxes.domainId, chunk)));
	const assignedAliases = await inChunks(candidateDomainIds, (chunk) => db
		.select({ mailboxId: mailboxAliases.mailboxId, domainId: mailboxAliases.domainId, localPart: mailboxAliases.localPart, enabled: mailboxAliases.enabled })
		.from(mailboxAliases)
		.where(inArray(mailboxAliases.domainId, chunk)));
	const byLocalPart = new Map<string, { mailboxes: typeof assignedMailboxes; aliases: typeof assignedAliases }>();
	const bucket = (localPart: string) => {
		const key = normalizeRecipientLocalPart(localPart);
		let entry = byLocalPart.get(key);
		if (!entry) byLocalPart.set(key, entry = { mailboxes: [], aliases: [] });
		return entry;
	};
	for (const item of assignedMailboxes) bucket(item.localPart).mailboxes.push(item);
	for (const item of assignedAliases) bucket(item.localPart).aliases.push(item);

	for (const mailbox of mailboxList) {
		const primaryDomain = primaryDomains.get(mailbox.domainId);
		if (!primaryDomain) {
			result.set(mailbox.id, []);
			continue;
		}
		const primaryAddress = `${mailbox.localPart}@${primaryDomain.hostname}`.toLowerCase();
		const ownAliases = aliasAddresses.get(mailbox.id) ?? [];
		if (!mailbox.useAllDomains) {
			result.set(mailbox.id, [...new Set([primaryAddress, ...ownAliases])]);
			continue;
		}
		// A domain is taken when another mailbox or alias owns the same normalized
		// local part on it, and also when this mailbox's own disabled alias does:
		// without that, disabling the alias would still leave the implicit
		// use-all-domains address sendable under the mailbox display name.
		const same = byLocalPart.get(normalizeRecipientLocalPart(mailbox.localPart));
		const assignedDomainIds = new Set([
			...(same?.mailboxes ?? []).filter((item) => item.id !== mailbox.id),
			...(same?.aliases ?? []).filter((item) => item.mailboxId !== mailbox.id || !item.enabled),
		].map((item) => item.domainId));
		result.set(mailbox.id, [
			...new Set([
				primaryAddress,
				...(availableByOwner.get(primaryDomain.userId) ?? [])
					.filter((domain) => domain.id !== mailbox.domainId && !assignedDomainIds.has(domain.id))
					.map((domain) => `${mailbox.localPart}@${domain.hostname}`.toLowerCase()),
				...ownAliases,
			]),
		]);
	}
	return result;
}

export async function ensureMailboxDomainRouting(
	env: CloudflareEnv,
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
	changes?: CfEmailRoutingRuleChange[],
	ruleCache: EmailRoutingRuleCache = new Map(),
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
			if (domain && domain.receivingProvider === "cloudflare") await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address, changes, ruleCache);
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

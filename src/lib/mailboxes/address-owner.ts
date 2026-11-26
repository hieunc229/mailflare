import { and, eq, inArray, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailGroups, mailboxAliases, mailboxes } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { normalizeRecipientLocalPart, parseRecipientAddress } from "@/lib/email/recipient-address";
import { getMailboxDomainAddresses } from "./domain-addresses";

export type AddressOwner = "mailbox" | "alias" | "group";

export type FindAddressOwnerOptions = {
	/**
	 * Also treat another "Use all domains" mailbox that receives this address as
	 * its owner (reported as "mailbox"). `exceptMailboxId` is the mailbox that is
	 * itself asking, such as the one an alias is being added to.
	 */
	allDomains?: { exceptMailboxId?: string };
};

const DOMAIN_CHUNK = 50;

export type AddressOwnerLookup = (domainId: string, localPart: string) => AddressOwner | null;

/**
 * Loads who owns addresses on these domains once, so any number of addresses
 * can then be checked in memory. Inbound routing resolves normalized local
 * parts (dots and +tags ignored), so a new address conflicts whenever its
 * normalized form matches, not only on an exact match. Checks run in routing
 * order: mailbox, alias, group, then (when asked) a "Use all domains" mailbox.
 */
export async function createAddressOwnerLookup(
	db: AppDatabase,
	domainIds: string[],
	options: FindAddressOwnerOptions = {},
): Promise<AddressOwnerLookup> {
	const ids = [...new Set(domainIds)];
	const taken = { mailbox: new Set<string>(), alias: new Set<string>(), group: new Set<string>() };
	const key = (domainId: string, localPart: string) => `${domainId}\0${normalizeRecipientLocalPart(localPart)}`;
	// D1 allows 100 bound parameters per statement, so large domain sets go in chunks.
	const chunks = Array.from({ length: Math.ceil(ids.length / DOMAIN_CHUNK) }, (_, index) => ids.slice(index * DOMAIN_CHUNK, (index + 1) * DOMAIN_CHUNK));
	const [domainMailboxes, domainAliases, domainGroups] = await Promise.all([
		Promise.all(chunks.map((chunk) => db.select({ domainId: mailboxes.domainId, localPart: mailboxes.localPart }).from(mailboxes).where(inArray(mailboxes.domainId, chunk)))),
		Promise.all(chunks.map((chunk) => db.select({ domainId: mailboxAliases.domainId, localPart: mailboxAliases.localPart }).from(mailboxAliases).where(inArray(mailboxAliases.domainId, chunk)))),
		Promise.all(chunks.map((chunk) => loadGroupAddresses(db, chunk))),
	]);
	for (const row of domainMailboxes.flat()) taken.mailbox.add(key(row.domainId, row.localPart));
	for (const row of domainAliases.flat()) taken.alias.add(key(row.domainId, row.localPart));
	for (const row of domainGroups.flat()) taken.group.add(key(row.domainId, row.localPart));
	const allDomains = options.allDomains ? await loadAllDomainsAddresses(db, ids, options.allDomains.exceptMailboxId) : null;
	return (domainId, localPart) => {
		const id = key(domainId, localPart);
		if (taken.mailbox.has(id)) return "mailbox";
		if (taken.alias.has(id)) return "alias";
		if (taken.group.has(id)) return "group";
		const hostname = allDomains?.hostnames.get(domainId);
		const address = hostname ? parseRecipientAddress(`${localPart}@${hostname}`)?.normalizedAddress : null;
		return address && allDomains?.addresses.has(address) ? "mailbox" : null;
	};
}

/** The same check for one address. */
export async function findAddressOwner(
	db: AppDatabase,
	domainId: string,
	localPart: string,
	options: FindAddressOwnerOptions = {},
): Promise<AddressOwner | null> {
	return (await createAddressOwnerLookup(db, [domainId], options))(domainId, localPart);
}

/** A group is optional: before its migration is applied no address belongs to one. */
async function loadGroupAddresses(db: AppDatabase, domainIds: string[]) {
	try {
		return await db.select({ domainId: mailGroups.domainId, localPart: mailGroups.localPart }).from(mailGroups).where(inArray(mailGroups.domainId, domainIds));
	} catch (error) {
		if (isMissingTableError(error)) return [];
		throw error;
	}
}

/** Addresses other mailboxes receive through "Use all domains", which a new address would silently take over. */
async function loadAllDomainsAddresses(db: AppDatabase, domainIds: string[], exceptMailboxId?: string) {
	const chunks = Array.from({ length: Math.ceil(domainIds.length / DOMAIN_CHUNK) }, (_, index) => domainIds.slice(index * DOMAIN_CHUNK, (index + 1) * DOMAIN_CHUNK));
	const [domainRows, candidates] = await Promise.all([
		Promise.all(chunks.map((chunk) => db.select({ id: domains.id, hostname: domains.hostname }).from(domains).where(inArray(domains.id, chunk)))),
		db
			.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
			.from(mailboxes)
			.where(exceptMailboxId
				? and(eq(mailboxes.useAllDomains, true), ne(mailboxes.id, exceptMailboxId))
				: eq(mailboxes.useAllDomains, true)),
	]);
	const addresses = new Set<string>();
	for (const candidate of candidates) {
		for (const item of await getMailboxDomainAddresses(db, candidate)) {
			const normalized = parseRecipientAddress(item)?.normalizedAddress;
			if (normalized) addresses.add(normalized);
		}
	}
	return { hostnames: new Map(domainRows.flat().map((row) => [row.id, row.hostname])), addresses };
}

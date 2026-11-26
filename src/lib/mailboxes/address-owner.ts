import { and, eq, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxAliases, mailboxes } from "@/db/schema";
import { normalizeRecipientLocalPart, parseRecipientAddress } from "@/lib/email/recipient-address";
import { getMailboxDomainAddresses } from "./domain-addresses";

export type AddressOwner = "mailbox" | "alias";

export type FindAddressOwnerOptions = {
	/**
	 * Also treat another "Use all domains" mailbox that receives this address as
	 * its owner (reported as "mailbox"). `exceptMailboxId` is the mailbox that is
	 * itself asking, such as the one an alias is being added to.
	 */
	allDomains?: { exceptMailboxId?: string };
};

/**
 * Who already receives mail for this address, if anyone. Inbound routing
 * resolves normalized local parts (dots and +tags ignored), so a new address
 * conflicts whenever its normalized form matches, not only on an exact match.
 */
export async function findAddressOwner(
	db: AppDatabase,
	domainId: string,
	localPart: string,
	options: FindAddressOwnerOptions = {},
): Promise<AddressOwner | null> {
	const normalized = normalizeRecipientLocalPart(localPart);
	const [domainMailboxes, domainAliases] = await Promise.all([
		db.select({ localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, domainId)),
		db.select({ localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domainId)),
	]);
	if (domainMailboxes.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) return "mailbox";
	if (domainAliases.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) return "alias";
	if (options.allDomains && (await findAllDomainsMailboxFor(db, domainId, localPart, options.allDomains.exceptMailboxId))) {
		return "mailbox";
	}
	return null;
}

/** Another mailbox that receives this address through "Use all domains", which a new address would silently take over. */
async function findAllDomainsMailboxFor(db: AppDatabase, domainId: string, localPart: string, exceptMailboxId?: string) {
	const [domain] = await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.id, domainId)).limit(1);
	const target = domain ? parseRecipientAddress(`${localPart}@${domain.hostname}`)?.normalizedAddress : null;
	if (!target) return null;
	const candidates = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
		.from(mailboxes)
		.where(exceptMailboxId
			? and(eq(mailboxes.useAllDomains, true), ne(mailboxes.id, exceptMailboxId))
			: eq(mailboxes.useAllDomains, true));
	for (const candidate of candidates) {
		const addresses = await getMailboxDomainAddresses(db, candidate);
		if (addresses.some((item) => parseRecipientAddress(item)?.normalizedAddress === target)) return candidate;
	}
	return null;
}

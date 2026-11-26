import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { contacts, domains, mailboxes, users } from "@/db/schema";
import { getContactId } from "@/lib/contacts/utils";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { tracksAccountIdentity } from "./identity-utils";
import type { PersonalIdentity } from "./sync-types";

export async function syncPersonalIdentity(
	db: AppDatabase,
	identity: PersonalIdentity,
): Promise<void> {
	await db
		.update(users)
		.set({ name: identity.name, avatarKey: identity.avatarKey })
		.where(eq(users.id, identity.userId));

	const [account] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, identity.userId))
		.limit(1);

	const personalMailboxes = await db
		.select({ mailbox: mailboxes, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(eq(mailboxes.userId, identity.userId), eq(mailboxes.type, "personal")));

	for (const { mailbox, hostname } of personalMailboxes) {
		// Only the primary mailbox mirrors the profile. Secondary mailboxes keep
		// the name and avatar they were given.
		const isIdentityMailbox = tracksAccountIdentity(
			{ localPart: mailbox.localPart, hostname, type: mailbox.type },
			account?.email,
		);
		if (isIdentityMailbox) {
			await db
				.update(mailboxes)
				.set({ displayName: identity.name, avatarKey: identity.avatarKey })
				.where(eq(mailboxes.id, mailbox.id));
		}
		const displayName = isIdentityMailbox ? identity.name : mailbox.displayName ?? identity.name;
		const avatarKey = isIdentityMailbox ? identity.avatarKey : mailbox.avatarKey;

		for (const email of await getMailboxDomainAddresses(db, mailbox)) {
			await db
				.insert(contacts)
				.values({
					id: getContactId(identity.userId, email),
					userId: identity.userId,
					email,
					displayName,
					avatarKey,
					source: "manual",
				})
				.onConflictDoUpdate({
					target: [contacts.userId, contacts.email],
					set: {
						displayName,
						avatarKey,
						source: "manual",
					},
				});
		}
	}
}

/** Every address of the user's personal mailboxes: the ones getPersonalIdentityForAddress matches. */
export async function getPersonalAddresses(db: AppDatabase, userId: string): Promise<Set<string>> {
	const personalMailboxes = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.type, "personal")));
	const found = new Set<string>();
	for (const mailbox of personalMailboxes) for (const address of await getMailboxDomainAddresses(db, mailbox)) found.add(address);
	return found;
}

export async function getPersonalIdentityForAddress(
	db: AppDatabase,
	userId: string,
	email: string,
) {
	const [account] = await db
		.select({ userId: users.id, name: users.name, avatarKey: users.avatarKey })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!account) return null;

	const personalMailboxes = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.type, "personal")));
	for (const mailbox of personalMailboxes) {
		const addresses = await getMailboxDomainAddresses(db, mailbox);
		if (addresses.includes(email)) return account;
	}
	return null;
}

import { and, eq, inArray, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailGroupMembers, users } from "@/db/schema";
import { singleSenderAddress } from "@/lib/groups/policy-utils";
import { resolveMailboxForAddress } from "@/lib/email/routing";

/** Hostnames of every active domain of this installation, for the `org` policy. */
export async function loadOrgHostnames(db: AppDatabase): Promise<string[]> {
	const rows = await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.status, "active"));
	return rows.map((row) => row.hostname.toLowerCase());
}

/**
 * Whether any of the addresses is an external member of the group. Used for the auto-ack guard: a
 * helpdesk that is a member answers a relayed copy with `Auto-Submitted: auto-generated` to the group,
 * which would be relayed again. Exact addresses only (a domain match would also drop every automated
 * message from gmail.com the moment one member is on it).
 */
export async function isExternalMember(db: AppDatabase, groupId: string, addresses: string[]): Promise<boolean> {
	const wanted = [...new Set(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
	if (!wanted.length) return false;
	const [row] = await db
		.select({ id: mailGroupMembers.id })
		.from(mailGroupMembers)
		.where(and(eq(mailGroupMembers.groupId, groupId), eq(mailGroupMembers.kind, "external"), inArray(mailGroupMembers.email, wanted)))
		.limit(1);
	return !!row;
}

/**
 * The member addresses relevant to one sender: a set holding the sender's address when it belongs
 * to a member, else empty. Answering for one address takes a handful of queries however large the
 * group is (500 members would otherwise cost thousands of D1 subrequests in the live handler).
 *
 * Members are: user members' primary address and the addresses of their own mailbox, mailbox
 * members' addresses (including aliases), and external members' emails.
 */
export async function findMemberSenderAddress(db: AppDatabase, groupId: string, senderHeader: string): Promise<Set<string>> {
	const sender = singleSenderAddress(senderHeader);
	const found = new Set<string>();
	if (!sender) return found;

	const [external] = await db
		.select({ id: mailGroupMembers.id })
		.from(mailGroupMembers)
		.where(and(eq(mailGroupMembers.groupId, groupId), eq(mailGroupMembers.kind, "external"), eq(mailGroupMembers.email, sender)))
		.limit(1);
	if (external) found.add(sender);

	const userIds = new Set<string>();
	const mailboxIds = new Set<string>();
	const [account] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, sender), eq(users.disabled, false))).limit(1);
	if (account) userIds.add(account.id);
	const mailbox = await resolveMailboxForAddress(db, sender);
	if (mailbox) {
		mailboxIds.add(mailbox.id);
		// The mailbox speaks for its account when it is the account's own address.
		const [owner] = await db.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.id, mailbox.userId), eq(users.disabled, false))).limit(1);
		const [domain] = owner ? await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.id, mailbox.domainId)).limit(1) : [];
		if (owner && domain && `${mailbox.localPart}@${domain.hostname}`.toLowerCase() === owner.email.toLowerCase()) userIds.add(owner.id);
	}
	const conditions = [
		userIds.size ? and(eq(mailGroupMembers.kind, "user"), inArray(mailGroupMembers.userId, [...userIds])) : undefined,
		mailboxIds.size ? and(eq(mailGroupMembers.kind, "mailbox"), inArray(mailGroupMembers.mailboxId, [...mailboxIds])) : undefined,
	].filter((condition) => condition !== undefined);
	if (conditions.length) {
		const [member] = await db
			.select({ id: mailGroupMembers.id })
			.from(mailGroupMembers)
			.where(and(eq(mailGroupMembers.groupId, groupId), or(...conditions)))
			.limit(1);
		if (member) found.add(sender);
	}
	return found;
}

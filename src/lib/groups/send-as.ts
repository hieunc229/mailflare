import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailGroupMembers, mailGroups } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { getEmailAddress } from "@/lib/email/address";
import { groupsAllowed } from "@/lib/groups/license";
import { isPrimaryMailbox } from "@/lib/profile/identity-utils";

export type SendAsGroup = { groupId: string; name: string; address: string };

/**
 * The group `address` names when `actorUserId` is a user member of it with "Can send as group" on and
 * the group is enabled (spec D-10). The address must be the group's own, character for character: a +tag
 * or dotted variant is not the group and sends as nothing. Before the groups migration there is no group.
 */
export async function findSendAsGroup(db: AppDatabase, actorUserId: string, address: string): Promise<SendAsGroup | null> {
	const requested = getEmailAddress(address).toLowerCase();
	const at = requested.lastIndexOf("@");
	if (at < 1) return null;
	const localPart = requested.slice(0, at);
	const hostname = requested.slice(at + 1);
	try {
		const rows = await db
			.select({ groupId: mailGroups.id, name: mailGroups.name, localPart: mailGroups.localPart, hostname: domains.hostname })
			.from(mailGroupMembers)
			.innerJoin(mailGroups, eq(mailGroupMembers.groupId, mailGroups.id))
			.innerJoin(domains, eq(mailGroups.domainId, domains.id))
			.where(and(
				eq(mailGroupMembers.userId, actorUserId),
				eq(mailGroupMembers.kind, "user"),
				eq(mailGroupMembers.canSendAs, true),
				eq(mailGroups.disabled, false),
				eq(domains.hostname, hostname),
			));
		const row = rows.find((item) => item.localPart.toLowerCase() === localPart);
		return row ? { groupId: row.groupId, name: row.name, address: `${row.localPart}@${row.hostname}`.toLowerCase() } : null;
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

/** Only the account's own primary mailbox carries group addresses: a shared or secondary mailbox never does. */
export function isOwnPrimaryMailbox(
	actor: { id: string; email: string },
	mailbox: { userId: string; type: string; localPart: string; hostname: string },
): boolean {
	return mailbox.type === "personal" && mailbox.userId === actor.id && isPrimaryMailbox(mailbox, actor.email);
}

/** Groups the actor may add to the primary mailbox's From list (none elsewhere, without the licence or before the migration). */
export async function listSendAsGroups(
	env: CloudflareEnv,
	db: AppDatabase,
	actor: { id: string; email: string },
	mailbox: { userId: string; type: string; localPart: string; hostname: string },
): Promise<{ address: string; name: string }[]> {
	if (!isOwnPrimaryMailbox(actor, mailbox) || !(await groupsAllowed(env)())) return [];
	try {
		const rows = await db
			.select({ localPart: mailGroups.localPart, name: mailGroups.name, hostname: domains.hostname })
			.from(mailGroupMembers)
			.innerJoin(mailGroups, eq(mailGroupMembers.groupId, mailGroups.id))
			.innerJoin(domains, eq(mailGroups.domainId, domains.id))
			.where(and(eq(mailGroupMembers.userId, actor.id), eq(mailGroupMembers.kind, "user"), eq(mailGroupMembers.canSendAs, true), eq(mailGroups.disabled, false)));
		return rows.map((row) => ({ address: `${row.localPart}@${row.hostname}`.toLowerCase(), name: row.name })).sort((a, b) => a.address.localeCompare(b.address));
	} catch (error) {
		if (isMissingTableError(error)) return [];
		throw error;
	}
}

export async function listSendAsGroupAddresses(
	env: CloudflareEnv,
	db: AppDatabase,
	actor: { id: string; email: string },
	mailbox: { userId: string; type: string; localPart: string; hostname: string },
): Promise<string[]> {
	return (await listSendAsGroups(env, db, actor, mailbox)).map((group) => group.address);
}

/**
 * The one decision every send path asks (web composer, API, MCP, JMAP, queued and scheduled delivery):
 * the group `address` may go out from `mailbox` for `actor` only when the licence allows groups, the
 * mailbox is the actor's own primary mailbox, and `findSendAsGroup` finds a flag for the actor.
 */
export async function authorizeSendAsGroup(
	env: CloudflareEnv,
	db: AppDatabase,
	actor: { id: string; email: string; disabled?: boolean | null },
	mailbox: { userId: string; type: string; localPart: string; hostname: string },
	address: string,
): Promise<SendAsGroup | null> {
	if (actor.disabled) return null;
	if (!isOwnPrimaryMailbox(actor, mailbox)) return null;
	if (!(await groupsAllowed(env)())) return null;
	return findSendAsGroup(db, actor.id, address);
}

import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailGroupMembers, mailGroups } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { getEmailAddress } from "@/lib/email/address";
import { groupsAllowed } from "@/lib/groups/license";

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
	if (mailbox.type === "shared" || mailbox.userId !== actor.id) return null;
	if (`${mailbox.localPart}@${mailbox.hostname}`.toLowerCase() !== actor.email.toLowerCase()) return null;
	if (!(await groupsAllowed(env)())) return null;
	return findSendAsGroup(db, actor.id, address);
}

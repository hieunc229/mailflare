import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { isAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import type { MailboxAccessLevel, MailboxPermission } from "./types";

const permissionRank: Record<MailboxPermission, number> = {
	read_only: 1,
	send_on_behalf: 2,
	send_as: 3,
	full_access: 4,
};

export function hasMailboxPermission(permission: MailboxPermission, required: MailboxPermission): boolean {
	return permissionRank[permission] >= permissionRank[required];
}

export async function getMailboxAccessLevel(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "role">,
	mailboxId: string,
): Promise<MailboxAccessLevel | null> {
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
	if (!mailbox || mailbox.disabled) return null;

	const [domain] = await db.select().from(domains).where(eq(domains.id, mailbox.domainId)).limit(1);
	const isOwner = mailbox.userId === user.id || (isAdmin(user) && domain?.userId === user.id);
	if (isOwner) return buildAccess(mailbox, "full_access", true);

	return null;
}

export async function listAccessibleMailboxes(db: AppDatabase, user: Pick<SessionUser, "id" | "email" | "role">) {
	const rows = await db
		.select({
			id: mailboxes.id,
			userId: mailboxes.userId,
			domainId: mailboxes.domainId,
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			forwardTo: mailboxes.forwardTo,
			type: mailboxes.type,
			disabled: mailboxes.disabled,
			createdAt: mailboxes.createdAt,
			hostname: domains.hostname,
			domainUserId: domains.userId,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id));
	return rows
		.filter((row) => {
			if (row.disabled) return false;
			if (row.userId === user.id) return true;
			if (isAdmin(user) && row.domainUserId === user.id) return true;
			return false;
		})
		.map((row) => ({
			...row,
			permission: "full_access" as MailboxPermission,
			isPrimary: `${row.localPart}@${row.hostname}` === user.email,
		}));
}

export async function listAccessibleMailboxIds(db: AppDatabase, user: Pick<SessionUser, "id" | "email" | "role">) {
	const rows = await listAccessibleMailboxes(db, user);
	return rows.map((row) => row.id);
}

function buildAccess(
	mailbox: MailboxAccessLevel["mailbox"],
	permission: MailboxPermission,
	isOwner: boolean,
): MailboxAccessLevel {
	return {
		mailbox,
		permission,
		isOwner,
		canRead: hasMailboxPermission(permission, "read_only"),
		canSendAs: hasMailboxPermission(permission, "send_as"),
		canSendOnBehalf: hasMailboxPermission(permission, "send_on_behalf"),
		canManage: hasMailboxPermission(permission, "full_access"),
	};
}

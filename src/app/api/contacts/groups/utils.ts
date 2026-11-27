import { and, asc, eq, ne, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { contactGroupMembers, contactGroups, contacts } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

/**
 * Groups live in the mailbox owner's address book — the same book
 * `/api/contacts` resolves through `access.mailbox.userId`. Managing them
 * takes the contacts mutation gate (`canManage`): a read-only delegate sees
 * contact addresses on this mailbox's mail, but the owner's group structure
 * stays private, so reads get the same 404 as writes here.
 */
export async function getGroupBookOwner(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "role">,
	mailboxId: string,
): Promise<string | null> {
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	return access?.canManage ? access.mailbox.userId : null;
}

/** The group a caller may touch: only one in the accessed book, so a foreign id gets the same 404 as a missing row. */
export async function getOwnedGroup(db: AppDatabase, userId: string, id: string) {
	const [row] = await db
		.select()
		.from(contactGroups)
		.where(and(eq(contactGroups.id, id), eq(contactGroups.userId, userId)))
		.limit(1);
	return row ?? null;
}

/**
 * Whether `name` collides with another group in the book. The unique index is
 * case-sensitive on SQLite and PostgreSQL, but group labels compare
 * case-insensitively everywhere — MySQL's collation already enforces it at the
 * table level — so callers refuse "Family" next to "family" themselves.
 */
export async function findGroupNameConflict(db: AppDatabase, userId: string, name: string, exceptId?: string) {
	const conditions: SQL[] = [
		eq(contactGroups.userId, userId),
		sql`lower(${contactGroups.name}) = ${name.toLowerCase()}`,
	];
	if (exceptId) conditions.push(ne(contactGroups.id, exceptId));
	const [row] = await db
		.select({ id: contactGroups.id })
		.from(contactGroups)
		.where(and(...conditions))
		.limit(1);
	return row ?? null;
}

export async function listGroupMembers(db: AppDatabase, groupId: string) {
	const rows = await db
		.select({ member: contactGroupMembers, contact: contacts })
		.from(contactGroupMembers)
		.innerJoin(contacts, eq(contactGroupMembers.contactId, contacts.id))
		.where(eq(contactGroupMembers.groupId, groupId))
		// Contacts order the same way the address book lists them.
		.orderBy(
			asc(sql`lower(coalesce(${contacts.displayName}, ${contacts.email}))`),
			asc(contacts.email),
		);
	// A member row only links a contact; `createdAt` is when it joined the group.
	return rows.map(({ member, contact }) => ({
		id: member.id,
		contactId: contact.id,
		email: contact.email,
		displayName: contact.displayName,
		hasAvatar: !!contact.avatarKey,
		createdAt: member.createdAt,
	}));
}

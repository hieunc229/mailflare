import { asc, eq } from "drizzle-orm";
import type { getDb } from "@/db";
import { folders } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

type Db = ReturnType<typeof getDb>;

export async function getMailboxFolderAccess(db: Db, user: SessionUser, mailboxId: string) {
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return null;
	return { mailboxId: access.mailbox.id, mailboxUserId: access.mailbox.userId, canManage: access.canManage };
}

export function listFoldersForMailbox(db: Db, mailboxId: string) {
	return db
		.select()
		.from(folders)
		.where(eq(folders.mailboxId, mailboxId))
		.orderBy(asc(folders.name));
}

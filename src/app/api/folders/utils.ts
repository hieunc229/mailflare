import { and, asc, count, eq } from "drizzle-orm";
import type { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
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

export async function getFolderForMailbox(db: Db, folderId: string, mailboxId: string) {
	const [folder] = await db
		.select()
		.from(folders)
		.where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))
		.limit(1);
	return folder ?? null;
}

/** Deleting a folder returns its messages to the inbox (status and snooze stay, only the folder is cleared) before the folder row goes. */
export async function deleteFolderMovingMessagesToInbox(db: Db, folder: { id: string; mailboxId: string }): Promise<number> {
	const inFolder = and(eq(messages.folderId, folder.id), eq(messages.mailboxId, folder.mailboxId));
	const [{ n }] = await db.select({ n: count() }).from(messages).where(inFolder);
	await db.update(messages).set({ folderId: null }).where(inFolder);
	await db.delete(folders).where(and(eq(folders.id, folder.id), eq(folders.mailboxId, folder.mailboxId)));
	return n;
}

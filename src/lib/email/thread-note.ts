import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, threadNotes, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { sanitizeNoteHtml } from "@/lib/email/note-html";
import { threadKeyFor } from "@/lib/email/thread-key";
import type { SessionUser } from "@/lib/auth/types";

export { threadKeyFor };

export const THREAD_NOTE_MAX_LENGTH = 8_000;

export type ThreadNote = {
	body: string;
	updatedByName: string | null;
	updatedAt: string;
};

type Database = ReturnType<typeof getDb>;

export async function readMessageThreadTarget(db: Database, messageId: string) {
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, threadId: messages.threadId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	return { mailboxId: message.mailboxId, threadKey: threadKeyFor(message) };
}

export async function getThreadNote(db: Database, mailboxId: string, threadKey: string): Promise<ThreadNote | null> {
	const [row] = await db
		.select({
			body: threadNotes.body,
			updatedAt: threadNotes.updatedAt,
			updatedByName: users.name,
		})
		.from(threadNotes)
		.leftJoin(users, eq(threadNotes.updatedByUserId, users.id))
		.where(and(eq(threadNotes.mailboxId, mailboxId), eq(threadNotes.threadKey, threadKey)))
		.limit(1);
	if (!row) return null;
	return {
		body: row.body,
		updatedByName: row.updatedByName,
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Save or clear the conversation note. An empty body removes it.
 * The caller has already checked that this user can read the mailbox.
 */
export async function saveThreadNote(
	db: Database,
	input: { mailboxId: string; threadKey: string; body: string; userId: string },
): Promise<ThreadNote | null> {
	const body = sanitizeNoteHtml(input.body);
	if (!body) {
		await db
			.delete(threadNotes)
			.where(and(eq(threadNotes.mailboxId, input.mailboxId), eq(threadNotes.threadKey, input.threadKey)));
		return null;
	}
	if (body.length > THREAD_NOTE_MAX_LENGTH) {
		throw new Error("Note is too long");
	}
	const now = new Date();
	await db
		.insert(threadNotes)
		.values({
			id: newId("note"),
			mailboxId: input.mailboxId,
			threadKey: input.threadKey,
			body,
			createdByUserId: input.userId,
			updatedByUserId: input.userId,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [threadNotes.mailboxId, threadNotes.threadKey],
			set: { body, updatedByUserId: input.userId, updatedAt: now },
		});
	return getThreadNote(db, input.mailboxId, input.threadKey);
}

/** Read the note for a message the user can already read. Returns null when the message is missing or unreadable. */
export async function getThreadNoteForMessage(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
): Promise<ThreadNote | null | "missing"> {
	const db = getDb(env);
	const target = await readMessageThreadTarget(db, messageId);
	if (!target) return "missing";
	const access = await getMailboxAccessLevel(db, user, target.mailboxId);
	if (!access?.canRead) return "missing";
	return getThreadNote(db, target.mailboxId, target.threadKey);
}

/** Save the note for a message the user can already read. */
export async function saveThreadNoteForMessage(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	body: string,
): Promise<ThreadNote | null | "missing" | "too-long"> {
	const db = getDb(env);
	const target = await readMessageThreadTarget(db, messageId);
	if (!target) return "missing";
	const access = await getMailboxAccessLevel(db, user, target.mailboxId);
	if (!access?.canRead) return "missing";
	try {
		return await saveThreadNote(db, { ...target, body, userId: user.id });
	} catch (error) {
		if (error instanceof Error && error.message === "Note is too long") return "too-long";
		throw error;
	}
}

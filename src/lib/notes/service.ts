import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { conversationNotes, messages, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import type { SessionUser } from "@/lib/auth/types";
import type { ConversationNote } from "./types";

/** Longest note the API accepts. */
export const CONVERSATION_NOTE_MAX_LENGTH = 10_000;

/**
 * The conversation `messageId` sits in, when the user may read its mailbox.
 * Keyed like the message list's `coalesce(thread_id, id)`: every message of a
 * thread resolves to the same key, and an unthreaded message is its own key.
 */
export async function conversationAnchorForUser(db: AppDatabase, user: SessionUser, messageId: string) {
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, threadId: messages.threadId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	return { mailboxId: message.mailboxId, threadKey: message.threadId ?? message.id };
}

const noteColumns = {
	id: conversationNotes.id,
	body: conversationNotes.body,
	messageId: conversationNotes.messageId,
	authorId: conversationNotes.savedByUserId,
	authorName: users.name,
	authorAvatarKey: users.avatarKey,
	createdAt: conversationNotes.createdAt,
};

function toNote(row: { id: string; body: string; messageId: string | null; authorId: string | null; authorName: string | null; authorAvatarKey: string | null; createdAt: Date }): ConversationNote {
	return {
		id: row.id,
		body: row.body,
		messageId: row.messageId,
		authorId: row.authorId,
		authorName: row.authorName,
		authorHasAvatar: !!row.authorAvatarKey,
		createdAt: row.createdAt.toISOString(),
	};
}

/** Every note on the conversation, oldest first. */
export async function listConversationNotes(db: AppDatabase, mailboxId: string, threadKey: string): Promise<ConversationNote[]> {
	const rows = await db
		.select(noteColumns)
		.from(conversationNotes)
		.leftJoin(users, eq(conversationNotes.savedByUserId, users.id))
		.where(and(eq(conversationNotes.mailboxId, mailboxId), eq(conversationNotes.threadKey, threadKey)))
		.orderBy(asc(conversationNotes.createdAt), asc(conversationNotes.id));
	return rows.map(toNote);
}

/** Whether `messageId` is an email of this conversation, so a note cannot point into another one. */
export async function isMessageInConversation(db: AppDatabase, mailboxId: string, threadKey: string, messageId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(
			eq(messages.id, messageId),
			eq(messages.mailboxId, mailboxId),
			or(eq(messages.threadId, threadKey), and(isNull(messages.threadId), eq(messages.id, threadKey))),
		))
		.limit(1);
	return !!row;
}

/** Adds a note, optionally attached to one email of the conversation (the caller has checked it belongs). */
export async function addConversationNote(db: AppDatabase, mailboxId: string, threadKey: string, body: string, authorId: string, messageId: string | null = null): Promise<ConversationNote> {
	const id = newId("cnote");
	await db.insert(conversationNotes).values({ id, mailboxId, threadKey, body, messageId, savedByUserId: authorId, createdAt: new Date() });
	const [row] = await db
		.select(noteColumns)
		.from(conversationNotes)
		.leftJoin(users, eq(conversationNotes.savedByUserId, users.id))
		.where(eq(conversationNotes.id, id))
		.limit(1);
	return toNote(row);
}

/** The avatar key of `authorId`, only when they wrote a note on this conversation. */
export async function noteAuthorAvatarKey(db: AppDatabase, mailboxId: string, threadKey: string, authorId: string): Promise<string | null> {
	const [row] = await db
		.select({ avatarKey: users.avatarKey })
		.from(conversationNotes)
		.innerJoin(users, eq(conversationNotes.savedByUserId, users.id))
		.where(and(eq(conversationNotes.mailboxId, mailboxId), eq(conversationNotes.threadKey, threadKey), eq(conversationNotes.savedByUserId, authorId)))
		.limit(1);
	return row?.avatarKey ?? null;
}

/** Rewrites a note's text. Only its author may, so a mismatch changes nothing and returns null. */
export async function updateConversationNote(db: AppDatabase, mailboxId: string, threadKey: string, noteId: string, authorId: string, body: string): Promise<ConversationNote | null> {
	const updated = await db
		.update(conversationNotes)
		.set({ body })
		.where(noteOfAuthor(mailboxId, threadKey, noteId, authorId))
		.returning({ id: conversationNotes.id });
	if (!updated.length) return null;
	const [row] = await db
		.select(noteColumns)
		.from(conversationNotes)
		.leftJoin(users, eq(conversationNotes.savedByUserId, users.id))
		.where(eq(conversationNotes.id, noteId))
		.limit(1);
	return row ? toNote(row) : null;
}

/** Deletes a note. Only its author may; returns whether a note was removed. */
export async function deleteConversationNote(db: AppDatabase, mailboxId: string, threadKey: string, noteId: string, authorId: string): Promise<boolean> {
	const deleted = await db
		.delete(conversationNotes)
		.where(noteOfAuthor(mailboxId, threadKey, noteId, authorId))
		.returning({ id: conversationNotes.id });
	return deleted.length > 0;
}

function noteOfAuthor(mailboxId: string, threadKey: string, noteId: string, authorId: string) {
	return and(
		eq(conversationNotes.id, noteId),
		eq(conversationNotes.mailboxId, mailboxId),
		eq(conversationNotes.threadKey, threadKey),
		eq(conversationNotes.savedByUserId, authorId),
	);
}

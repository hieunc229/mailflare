import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { conversationNotes, messages, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import type { SessionUser } from "@/lib/auth/types";
import type { ConversationNote } from "./types";

/** Longest note the API accepts; the same ceiling the agent tools put on a body. */
export const CONVERSATION_NOTE_MAX_LENGTH = 40_000;

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

export async function getConversationNote(db: AppDatabase, mailboxId: string, threadKey: string): Promise<ConversationNote | null> {
	const [row] = await db
		.select({
			id: conversationNotes.id,
			html: conversationNotes.html,
			savedByName: users.name,
			updatedAt: conversationNotes.updatedAt,
		})
		.from(conversationNotes)
		.leftJoin(users, eq(conversationNotes.savedByUserId, users.id))
		.where(and(eq(conversationNotes.mailboxId, mailboxId), eq(conversationNotes.threadKey, threadKey)))
		.limit(1);
	return row ? { id: row.id, html: row.html, savedByName: row.savedByName, updatedAt: row.updatedAt.toISOString() } : null;
}

/** Saves the note for the conversation, replacing whatever was there. */
export async function setConversationNote(db: AppDatabase, mailboxId: string, threadKey: string, html: string, savedByUserId: string): Promise<ConversationNote | null> {
	const now = new Date();
	await db
		.insert(conversationNotes)
		.values({
			id: newId("cnote"),
			mailboxId,
			threadKey,
			html,
			savedByUserId,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [conversationNotes.mailboxId, conversationNotes.threadKey],
			set: { html, savedByUserId, updatedAt: now },
		});
	return getConversationNote(db, mailboxId, threadKey);
}

export async function clearConversationNote(db: AppDatabase, mailboxId: string, threadKey: string): Promise<void> {
	await db
		.delete(conversationNotes)
		.where(and(eq(conversationNotes.mailboxId, mailboxId), eq(conversationNotes.threadKey, threadKey)));
}

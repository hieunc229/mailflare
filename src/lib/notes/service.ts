import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { conversationNotes, messages, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import type { SessionUser } from "@/lib/auth/types";
import { canDeleteNote, canEditNote } from "./note-permissions";
import type { ConversationNote, NoteChangeResult, NoteConversation } from "./types";

/** Longest note the API accepts; the same ceiling the agent tools put on a body. */
export const CONVERSATION_NOTE_MAX_LENGTH = 40_000;

/**
 * The conversation `messageId` sits in, when the user may read its mailbox.
 * Keyed like the message list's `coalesce(thread_id, id)`: every message of a
 * thread resolves to the same key, and an unthreaded message is its own key.
 */
export async function conversationForUser(db: AppDatabase, user: SessionUser, messageId: string): Promise<NoteConversation | null> {
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, threadId: messages.threadId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const threadKey = message.threadId ?? message.id;
	// Sending a queued message rekeys its thread by the provider Message-ID
	// (send.ts), so a note written while it was its own conversation stays under
	// the message id. Accepting every member's id keeps such notes reachable
	// from any email of the thread, e.g. a reply that arrives after the send.
	const members = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.mailboxId, message.mailboxId), eq(messages.threadId, threadKey)));
	return { mailboxId: message.mailboxId, threadKey, threadKeys: [...new Set([threadKey, message.id, ...members.map((member) => member.id)])], messageId: message.id, canManage: access.canManage };
}

/** Every note of the conversation, oldest first. */
export async function listConversationNotes(db: AppDatabase, conversation: NoteConversation, userId: string): Promise<ConversationNote[]> {
	const rows = await selectNotes(db)
		.where(and(eq(conversationNotes.mailboxId, conversation.mailboxId), inArray(conversationNotes.threadKey, conversation.threadKeys)))
		.orderBy(asc(conversationNotes.createdAt), asc(conversationNotes.id));
	return rows.map((row) => toNote(row, conversation, userId));
}

/** Adds a note by `userId`; with `attachToMessage` it is about the email the conversation was looked up from. */
export async function addConversationNote(
	db: AppDatabase,
	conversation: NoteConversation,
	userId: string,
	input: { html: string; attachToMessage?: boolean },
): Promise<ConversationNote> {
	const now = new Date();
	const id = newNoteId(now);
	await db.insert(conversationNotes).values({
		id,
		mailboxId: conversation.mailboxId,
		threadKey: conversation.threadKey,
		messageId: input.attachToMessage ? conversation.messageId : null,
		html: input.html,
		authorUserId: userId,
		createdAt: now,
		updatedAt: now,
	});
	const note = await findNote(db, conversation, userId, id);
	if (!note) throw new Error("The note was not saved");
	return note;
}

/** Replaces the text of a note in this conversation; only its author may. */
export async function updateConversationNote(
	db: AppDatabase,
	conversation: NoteConversation,
	userId: string,
	noteId: string,
	html: string,
): Promise<NoteChangeResult> {
	const row = await noteRow(db, conversation, noteId);
	if (!row) return { ok: false, error: "not_found" };
	if (!canEditNote(row.authorUserId, userId)) return { ok: false, error: "forbidden" };
	// Timestamps keep whole seconds, so an edit made in the note's own second must still land after created_at.
	const updatedAt = new Date(Math.max(Date.now(), row.createdAt.getTime() + 1000));
	await db.update(conversationNotes).set({ html, updatedAt }).where(eq(conversationNotes.id, noteId));
	const note = await findNote(db, conversation, userId, noteId);
	return note ? { ok: true, note } : { ok: false, error: "not_found" };
}

/** Deletes a note in this conversation; its author or a mailbox manager may. */
export async function deleteConversationNote(
	db: AppDatabase,
	conversation: NoteConversation,
	userId: string,
	noteId: string,
): Promise<{ ok: true } | { ok: false; error: "not_found" | "forbidden" }> {
	const row = await noteRow(db, conversation, noteId);
	if (!row) return { ok: false, error: "not_found" };
	if (!canDeleteNote(row.authorUserId, userId, conversation.canManage)) return { ok: false, error: "forbidden" };
	await db.delete(conversationNotes).where(eq(conversationNotes.id, noteId));
	return { ok: true };
}

let lastNoteIdTime = 0;

/**
 * created_at keeps whole seconds, so notes written in the same second are
 * ordered by id: it starts with the time in milliseconds, one higher than the
 * last when two notes share a millisecond.
 */
function newNoteId(now: Date): string {
	lastNoteIdTime = Math.max(now.getTime(), lastNoteIdTime + 1);
	return newId(`cnote_${lastNoteIdTime.toString(36).padStart(9, "0")}`);
}

/** The note's author and creation time; undefined when the note is not in this conversation. */
async function noteRow(db: AppDatabase, conversation: NoteConversation, noteId: string) {
	const [row] = await db
		.select({ authorUserId: conversationNotes.authorUserId, createdAt: conversationNotes.createdAt })
		.from(conversationNotes)
		.where(and(
			eq(conversationNotes.id, noteId),
			eq(conversationNotes.mailboxId, conversation.mailboxId),
			inArray(conversationNotes.threadKey, conversation.threadKeys),
		))
		.limit(1);
	return row;
}

async function findNote(db: AppDatabase, conversation: NoteConversation, userId: string, noteId: string): Promise<ConversationNote | null> {
	const [row] = await selectNotes(db).where(eq(conversationNotes.id, noteId)).limit(1);
	return row ? toNote(row, conversation, userId) : null;
}

function selectNotes(db: AppDatabase) {
	return db
		.select({
			id: conversationNotes.id,
			html: conversationNotes.html,
			messageId: conversationNotes.messageId,
			authorUserId: conversationNotes.authorUserId,
			authorName: users.name,
			authorAvatarKey: users.avatarKey,
			createdAt: conversationNotes.createdAt,
			updatedAt: conversationNotes.updatedAt,
		})
		.from(conversationNotes)
		.leftJoin(users, eq(conversationNotes.authorUserId, users.id));
}

type NoteRow = Awaited<ReturnType<ReturnType<typeof selectNotes>["where"]>>[number];

function toNote(row: NoteRow, conversation: NoteConversation, userId: string): ConversationNote {
	return {
		id: row.id,
		html: row.html,
		messageId: row.messageId,
		authorName: row.authorName,
		authorId: row.authorUserId,
		authorHasAvatar: !!row.authorAvatarKey,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		canEdit: canEditNote(row.authorUserId, userId),
		canDelete: canDeleteNote(row.authorUserId, userId, conversation.canManage),
	};
}

/** Avatar key of `authorId`, only when they wrote a note in this conversation. */
export async function noteAuthorAvatarKey(db: AppDatabase, conversation: NoteConversation, authorId: string): Promise<string | null> {
	const [row] = await db
		.select({ avatarKey: users.avatarKey })
		.from(conversationNotes)
		.innerJoin(users, eq(conversationNotes.authorUserId, users.id))
		.where(and(
			eq(conversationNotes.mailboxId, conversation.mailboxId),
			inArray(conversationNotes.threadKey, conversation.threadKeys),
			eq(conversationNotes.authorUserId, authorId),
		))
		.limit(1);
	return row?.avatarKey ?? null;
}

/** What a list row shows about the notes of its conversation. */
export type RowNoteSummary = { count: number; preview: string };

const PREVIEW_NOTES = 3;
const PREVIEW_CHARS = 140;

function noteText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/(p|div|li|h[1-6])>/gi, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The note count and a short text of the latest notes for each list row, by
 * message id. Rows are keyed like the conversation lookup: their thread, or
 * their own id (notes taken before a send rekeyed the thread live there).
 * The user must already be allowed to read these mailboxes.
 */
export async function summarizeNotesForRows(
	db: AppDatabase,
	rows: Array<{ id: string; mailboxId: string | null; threadId: string | null }>,
): Promise<Map<string, RowNoteSummary>> {
	const summaries = new Map<string, RowNoteSummary>();
	const scoped = rows.filter((row): row is { id: string; mailboxId: string; threadId: string | null } => !!row.mailboxId);
	if (scoped.length === 0) return summaries;
	const keys = [...new Set(scoped.flatMap((row) => [row.id, ...(row.threadId ? [row.threadId] : [])]))];
	const found = await db
		.select({
			mailboxId: conversationNotes.mailboxId,
			threadKey: conversationNotes.threadKey,
			html: conversationNotes.html,
			authorName: users.name,
		})
		.from(conversationNotes)
		.leftJoin(users, eq(conversationNotes.authorUserId, users.id))
		.where(and(
			inArray(conversationNotes.mailboxId, [...new Set(scoped.map((row) => row.mailboxId))]),
			inArray(conversationNotes.threadKey, keys),
		))
		.orderBy(asc(conversationNotes.createdAt), asc(conversationNotes.id));
	if (found.length === 0) return summaries;
	for (const row of scoped) {
		const mine = found.filter((note) => note.mailboxId === row.mailboxId && (note.threadKey === row.id || note.threadKey === row.threadId));
		if (mine.length === 0) continue;
		const lines = mine.slice(-PREVIEW_NOTES).map((note) => {
			const text = noteText(note.html);
			const clipped = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text;
			return `${note.authorName ?? "?"}: ${clipped}`;
		});
		const more = mine.length - lines.length;
		summaries.set(row.id, { count: mine.length, preview: more > 0 ? `${lines.join("\n")}\n+${more}` : lines.join("\n") });
	}
	return summaries;
}

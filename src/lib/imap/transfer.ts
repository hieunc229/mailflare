import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { imapMessageFlags, messageAttachments, messages } from "@/db/schema";
import { copyMessageAttachments } from "@/lib/email/attachments";
import { deleteUnreferencedObjects } from "@/lib/drive/shared-objects";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { newId } from "@/lib/ids";
import { encodeMailboxRef } from "@/lib/jmap/ids";
import { targetFromMailboxIds } from "@/lib/jmap/emails";
import { createAuditLogs } from "@/lib/mailboxes/audit";
import { applySpamFeedback } from "@/lib/spam/feedback";
import type { ImapIdentity } from "./auth";
import { no } from "./errors";
import { folderKeyOf, folderRefOfKey, type FolderKey } from "./folders";
import { ensureFolderState, syncMailbox } from "./sync";

/**
 * MOVE, COPY and EXPUNGE on the messages table. The rules for where a message may go are the
 * JMAP ones (`targetFromMailboxIds`), so IMAP, JMAP and the web agree; what differs is that a
 * MOVE writes all its rows in one batch, so it happens entirely or not at all, which JMAP's row by row
 * `Email/set` cannot promise. Each statement only matches rows that are still in the status and folder
 * they were read in, so a message another client filed in the meantime is left where it is.
 */
export type MessageRow = typeof messages.$inferSelect;
export type Destination = { mailboxId: string; key: FolderKey; ownerUserId: string };

/** Messages one MOVE may carry, and one COPY (each copy writes objects). */
export const MAX_MOVE_MESSAGES = 5000;
export const MAX_COPY_MESSAGES = 1000;
const ID_CHUNK = 80;
const STATEMENTS_PER_BATCH = 40;

const chunksOf = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** The rows of these messages that are in `mailboxId` and still in folder `key`, with whether each is flagged \Deleted. */
export async function loadFolderRows(env: CloudflareEnv, mailboxId: string, key: string, ids: string[]): Promise<Array<{ row: MessageRow; deleted: boolean }>> {
	const db = getDb(env);
	const result: Array<{ row: MessageRow; deleted: boolean }> = [];
	for (const chunk of chunksOf(ids, 90)) {
		const found = await db
			.select({ row: messages, deleted: imapMessageFlags.deleted })
			.from(messages)
			.leftJoin(imapMessageFlags, eq(imapMessageFlags.messageId, messages.id))
			.where(and(eq(messages.mailboxId, mailboxId), inArray(messages.id, chunk)));
		for (const entry of found) if (folderKeyOf(entry.row) === key) result.push({ row: entry.row, deleted: !!entry.deleted });
	}
	return result;
}

/** Where `row` ends up in `dest` by the JMAP rule, or the reason it may not go there. */
export function placeIn(row: MessageRow, dest: Destination): { status: string; folderId: string | null } | { error: string } {
	const ref = folderRefOfKey(dest.mailboxId, dest.key)!;
	const result = targetFromMailboxIds({ ...row, mailboxId: dest.mailboxId }, { mailboxIds: { [encodeMailboxRef(ref)]: true } }, new Set([dest.mailboxId]));
	if (!result || "error" in result) return { error: result && "error" in result ? String(result.error.description ?? "The message cannot go there") : "The message cannot go there" };
	return { status: result.status ?? row.status, folderId: result.folderId ?? null };
}

/** The row is still in the status and folder it was read in. */
const unchanged = (row: MessageRow) =>
	and(eq(messages.id, row.id), eq(messages.mailboxId, row.mailboxId!), eq(messages.status, row.status), row.folderId === null ? isNull(messages.folderId) : eq(messages.folderId, row.folderId));

/**
 * Removes messages for good, each only if it is still in the status and folder it was read in (so a message another client
 * filed elsewhere meanwhile is kept), then its raw object and attachment objects. Returns the rows that were removed.
 */
export async function deleteUnchanged(env: CloudflareEnv, identity: ImapIdentity, rows: MessageRow[]): Promise<MessageRow[]> {
	const db = getDb(env);
	const removed: MessageRow[] = [];
	for (const row of rows) {
		const attachments = await db.select({ id: messageAttachments.id, r2Key: messageAttachments.r2Key }).from(messageAttachments).where(eq(messageAttachments.messageId, row.id));
		const gone = await db.delete(messages).where(unchanged(row)).returning({ id: messages.id });
		if (!gone.length) continue;
		removed.push(row);
		try {
			await deleteUnreferencedObjects(env, db, attachments.map((attachment) => attachment.r2Key), { attachmentIds: attachments.map((attachment) => attachment.id) });
			if (row.rawR2Key) await env.BUCKET.delete(row.rawR2Key);
		} catch (error) {
			console.error(`IMAP could not remove the objects of ${row.id}`, error);
		}
	}
	await createAuditLogs(env, removed.map((row) => ({ actorUserId: identity.userId, mailboxId: row.mailboxId, action: "email.delete", metadata: { permanent: true, source: "imap", messageId: row.id, previousStatus: row.status } })));
	return removed;
}

/** Moves messages to Trash (what JMAP destroy does outside Trash and Drafts), each only if it is still in the status and folder it was read in. Returns the rows that moved. */
async function trashUnchanged(env: CloudflareEnv, identity: ImapIdentity, rows: MessageRow[]): Promise<MessageRow[]> {
	const db = getDb(env);
	const moved: MessageRow[] = [];
	for (const row of rows) {
		const result = await db.update(messages).set({ status: "trash", folderId: null }).where(unchanged(row)).returning({ id: messages.id });
		if (result.length) moved.push(row);
	}
	if (moved.length) {
		await db.update(imapMessageFlags).set({ deleted: false }).where(inArray(imapMessageFlags.messageId, moved.map((row) => row.id)));
		await createAuditLogs(env, moved.map((row) => ({ actorUserId: identity.userId, mailboxId: row.mailboxId, messageId: row.id, action: "email.delete", metadata: { status: "trash", source: "imap" } })));
	}
	return moved;
}

/** Moves messages of one mailbox to another folder of it; throws `NO [CANNOT]` before any change when a message may not go there. */
export async function moveMessages(env: CloudflareEnv, identity: ImapIdentity, rows: MessageRow[], dest: Destination, fromKey: FolderKey): Promise<void> {
	if (!rows.length) return;
	const db = getDb(env);
	const groups = new Map<string, { from: MessageRow; to: { status: string; folderId: string | null }; ids: string[] }>();
	for (const row of rows) {
		const placed = placeIn(row, dest);
		if ("error" in placed) throw no(placed.error, "CANNOT");
		const id = JSON.stringify([row.status, row.folderId, placed.status, placed.folderId]);
		const group = groups.get(id) ?? { from: row, to: placed, ids: [] };
		group.ids.push(row.id);
		groups.set(id, group);
	}
	const statements = [...groups.values()].flatMap(({ from, to, ids }) =>
		chunksOf(ids, ID_CHUNK).map((chunk) =>
			db
				.update(messages)
				.set({ status: to.status, folderId: to.folderId, ...(dest.key === "inbox" ? { snoozedUntil: null } : {}) })
				.where(and(eq(messages.mailboxId, dest.mailboxId), inArray(messages.id, chunk), eq(messages.status, from.status), from.folderId === null ? isNull(messages.folderId) : eq(messages.folderId, from.folderId))),
		),
	);
	const flagResets = chunksOf(rows.map((row) => row.id), ID_CHUNK).map((chunk) => db.update(imapMessageFlags).set({ deleted: false }).where(inArray(imapMessageFlags.messageId, chunk)));
	// One transaction for the whole command when it fits one batch; a larger MOVE is a few batches that each hold whole groups.
	for (const part of chunksOf([...statements, ...flagResets], STATEMENTS_PER_BATCH)) await db.batch(part as never);
	// What follows concerns the messages that are in the destination now; one that another client filed elsewhere meanwhile was not moved by this command.
	const landed = new Set((await loadFolderRows(env, dest.mailboxId, dest.key, rows.map((row) => row.id))).map((entry) => entry.row.id));
	const moved = rows.filter((row) => landed.has(row.id));
	if (dest.key === "trash") {
		await createAuditLogs(env, moved.map((row) => ({ actorUserId: identity.userId, mailboxId: dest.mailboxId, messageId: row.id, action: "email.delete", metadata: { status: "trash", source: "imap" } })));
	}
	await learnFromMove(env, identity, moved, dest.key, fromKey);
	await syncMailbox(env, dest.mailboxId);
}

/** Moving inbound mail into Junk is "Mark as spam" and out of Junk into INBOX is "Not spam": the filter learns from either (needs full access, as in the web UI). */
async function learnFromMove(env: CloudflareEnv, identity: ImapIdentity, rows: MessageRow[], to: FolderKey, from: FolderKey): Promise<void> {
	const classification = to === "junk" ? "spam" : from === "junk" && to === "inbox" ? "ham" : null;
	if (!classification) return;
	for (const row of rows) {
		if (row.direction !== "inbound") continue;
		try {
			await applySpamFeedback(env, identity.auth.user, row.id, classification);
		} catch (error) {
			// The move is done; a failed lesson is not worth undoing it.
			console.warn("IMAP spam feedback failed", error);
		}
	}
}

/**
 * Copies messages to a folder (of the same or another mailbox): a new row with the same content and a new id,
 * the raw object copied under a new key, the attachments through `copyMessageAttachments`, the IMAP flags kept
 * except \Deleted. When a copy fails the ones already made are removed again, so a COPY is all or nothing.
 * Returns the new id of each source id.
 */
export async function copyMessages(env: CloudflareEnv, identity: ImapIdentity, rows: MessageRow[], dest: Destination): Promise<Map<string, string>> {
	const placements = rows.map((row) => {
		const placed = placeIn(row, dest);
		if ("error" in placed) throw no(placed.error, "CANNOT");
		return placed;
	});
	const db = getDb(env);
	const made = new Map<string, string>();
	const rawKeys = new Map<string, string | null>();
	try {
		for (const [index, row] of rows.entries()) {
			const id = newId("msg");
			const rawKey = row.rawR2Key ? `copies/${id}.eml` : null;
			rawKeys.set(id, rawKey);
			const sameMailbox = row.mailboxId === dest.mailboxId;
			// The trash time is kept by triggers from the new status.
			const { trashedAt, ...columns } = row;
			void trashedAt;
			if (rawKey) {
				const object = await env.BUCKET.get(row.rawR2Key!);
				if (!object) rawKeys.set(id, null);
				else await env.BUCKET.put(rawKey, await object.arrayBuffer(), { httpMetadata: { contentType: "message/rfc822" } });
			}
			made.set(row.id, id);
			await db.insert(messages).values({
				...columns,
				id,
				mailboxId: dest.mailboxId,
				userId: sameMailbox ? row.userId : dest.key === "sent" || dest.key === "drafts" ? identity.userId : dest.ownerUserId,
				folderId: placements[index].folderId,
				status: placements[index].status,
				snoozedUntil: null,
				rawR2Key: rawKeys.get(id) ?? null,
				// A thread is a notion of one mailbox.
				threadId: sameMailbox ? row.threadId : null,
			});
			await copyMessageAttachments(env, row.id, id);
			const [flags] = await db.select().from(imapMessageFlags).where(eq(imapMessageFlags.messageId, row.id));
			if (flags) await db.insert(imapMessageFlags).values({ messageId: id, answered: flags.answered, forwarded: flags.forwarded, deleted: false, keywords: flags.keywords });
		}
	} catch (error) {
		for (const id of made.values()) {
			try {
				const [row] = await db.select().from(messages).where(eq(messages.id, id));
				if (row) await deleteMessageWithObjects(env, db, id, row.rawR2Key);
				else if (rawKeys.get(id)) await env.BUCKET.delete(rawKeys.get(id)!);
			} catch (cleanup) {
				console.error(`IMAP COPY could not remove the partial copy ${id}`, cleanup);
			}
		}
		console.error("IMAP COPY failed", error);
		throw no("The copy failed and nothing was copied", "SERVERBUG");
	}
	await syncMailbox(env, dest.mailboxId);
	return made;
}

/** The UIDs the messages have in a folder now, after a sync, in the order of `ids`; with the folder's UIDVALIDITY. */
export async function uidsOf(env: CloudflareEnv, mailboxId: string, key: string, ids: string[]): Promise<{ uidvalidity: number; uids: Array<number | null> }> {
	await syncMailbox(env, mailboxId);
	await ensureFolderState(env, mailboxId, key);
	const byId = new Map<string, number>();
	for (const chunk of chunksOf(ids, 90)) {
		const found = (await env.DB.prepare(`SELECT message_id, uid FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND message_id IN (${chunk.map(() => "?").join(", ")})`).bind(mailboxId, key, ...chunk).all<{ message_id: string; uid: number }>()).results;
		for (const row of found) byId.set(row.message_id, Number(row.uid));
	}
	const [state] = (await env.DB.prepare("SELECT uidvalidity FROM imap_folder_state WHERE id = ?").bind(`${mailboxId}:${key}`).all<{ uidvalidity: number }>()).results;
	return { uidvalidity: Number(state.uidvalidity), uids: ids.map((id) => byId.get(id) ?? null) };
}

/** Most flagged messages one EXPUNGE reads; a client with more asks again. */
const MAX_EXPUNGE_CANDIDATES = 10_000;

/**
 * Removes the messages flagged \Deleted in a folder (optionally only those whose UID is in `uids`) by the
 * JMAP destroy rule: out of Trash and Drafts for good, from any other folder to Trash. A message is re-read
 * before it goes, goes only if it is still in this folder and still flagged, and the removal itself only matches
 * the status and folder it was read in, so what another client changed meanwhile is never lost. Returns how many were removed from the folder.
 */
export async function expungeDeleted(env: CloudflareEnv, identity: ImapIdentity, mailboxId: string, key: FolderKey, only?: (uid: number) => boolean): Promise<number> {
	await syncMailbox(env, mailboxId);
	const candidates = (await env.DB
		.prepare("SELECT u.uid AS uid, u.message_id AS message_id FROM imap_uids u INNER JOIN imap_message_flags f ON f.message_id = u.message_id WHERE u.mailbox_id = ? AND u.folder_key = ? AND f.deleted = ? ORDER BY u.uid LIMIT ?")
		.bind(mailboxId, key, true, MAX_EXPUNGE_CANDIDATES)
		.all<{ uid: number; message_id: string }>()).results.filter((row) => !only || only(Number(row.uid)));
	let removed = 0;
	for (const chunk of chunksOf(candidates.map((row) => row.message_id), 90)) {
		const current = (await loadFolderRows(env, mailboxId, key, chunk)).filter((entry) => entry.deleted).map((entry) => entry.row);
		if (!current.length) continue;
		const permanent = current.filter((row) => row.status === "trash" || row.status === "draft");
		removed += (await trashUnchanged(env, identity, current.filter((row) => !permanent.includes(row)))).length;
		removed += (await deleteUnchanged(env, identity, permanent)).length;
	}
	await syncMailbox(env, mailboxId);
	return removed;
}

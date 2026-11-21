import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapFolderState, imapMailboxState } from "@/db/schema";
import { isRetryableConflictError } from "@/lib/database-errors";
import { SYSTEM_ROLES } from "@/lib/jmap/ids";
import { folderKeyCondition, folderKeyOf } from "./folders";

/**
 * Keeps the IMAP state tables (UID per message and folder, mod-sequences, the
 * expunge log) in step with Mailflare's messages. The source of "what changed"
 * is the JMAP change log (`jmap_changes`, written by triggers for every writer),
 * so IMAP adds no triggers and a deployment with IMAP off pays nothing. Nothing
 * here runs on a timer; callers sync when a session needs fresh state.
 *
 * Concurrency: syncs of one mailbox are serialized in this process, and several
 * processes may share one PostgreSQL or MySQL database. Across processes, UIDs and
 * mod-sequences become visible in increasing order because they are allocated and
 * written in the SAME atomic batch. Its first statement bumps the counters
 * (`imap_mailbox_state.modseq`, then `imap_folder_state.uid_next` of each folder
 * that gets new UIDs, always in that order); that takes the row lock and holds it
 * until commit, so a second writer waits and its numbers follow. Rows are written
 * with values derived from the counter inside the batch, never from a value read
 * earlier. This relies on the batch being one transaction, which holds for D1,
 * SQLite, node-postgres, PGlite and mysql2 but not for the PostgreSQL HTTP driver
 * (it runs batches as sequential statements), so that driver is single-writer only.
 * A plan made from reads before the batch can be stale when another writer got in
 * first; the unique indexes then fail the batch, it rolls back, and the sync starts
 * over. Counters only go up, and a rolled-back batch uses no numbers.
 *
 * A stale plan can also be one that no unique index notices: an INSERT for a
 * message that has left the folder, or a DELETE for a UID of a message that is
 * back, collides with nothing. So every batch carries a guard right after its
 * lock statement that fails it unless `imap_mailbox_state.jmap_seq` still has the
 * value the plan started from (the slice's start for a sync; the value read at the
 * start of a reconcile). Every committed sync or reconcile moves `jmap_seq`, so a
 * plan made before another writer committed cannot commit. The guard is read after
 * the lock is held, so it sees the committed state of the writer that held it.
 *
 * Statements bind at most 100 parameters and one batch holds a bounded number
 * of statements, so the same code fits D1's limits.
 */
type SyncEnv = Pick<CloudflareEnv, "DB">;

/** Changes read, and so messages applied, per atomic step. */
export const SYNC_STEP = 50;
const ID_CHUNK = 90;
/** Eight bound parameters per row (two of them inside the derived UID and mod-sequence), 12 rows stay under 100. */
const UID_ROWS_PER_INSERT = 12;
const RECONCILE_CHUNK = 150;
/** UIDs given a new mod-sequence per statement when a reconcile announces possibly missed flag changes. */
export const BUMP_CHUNK = 500;
const MAX_ATTEMPTS = 4;
/** `jmap_seq` of a mailbox whose first reconcile has not finished: always below the change floor, so it is redone. */
const UNFINISHED = -1;

class FolderInconsistent extends Error {
	constructor(readonly mailboxId: string, readonly folderKey: string) {
		super(`IMAP folder ${mailboxId}:${folderKey} has a UID at or above uid_next`);
	}
}

const num = (value: unknown) => Number(value ?? 0);
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function rows<T>(env: SyncEnv, query: string, ...params: unknown[]): Promise<T[]> {
	return (await env.DB.prepare(query).bind(...params).all<T>()).results;
}
const statement = (env: SyncEnv, query: string, ...params: unknown[]) => env.DB.prepare(query).bind(...params);
const chunks = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

type State = { jmapSeq: number; modseq: number };

async function readState(env: SyncEnv, mailboxId: string): Promise<State | null> {
	const [row] = await rows<{ jmap_seq: number; modseq: number }>(env, "SELECT jmap_seq, modseq FROM imap_mailbox_state WHERE mailbox_id = ?", mailboxId);
	return row ? { jmapSeq: num(row.jmap_seq), modseq: num(row.modseq) } : null;
}

async function readFloor(env: SyncEnv): Promise<number> {
	const [row] = await rows<{ seq: number }>(env, "SELECT seq FROM jmap_change_floor WHERE id = 1");
	return num(row?.seq);
}

// ---- Counters ----

type Fragment = { sql: string; params: unknown[] };

/**
 * The mod-sequence `offset` away from the mailbox counter as it stands after the
 * batch's lock statement. In a batch that reserved `n`, row `k` (1..n) is `k - n`.
 */
const modseqAt = (mailboxId: string, offset: number): Fragment => ({ sql: "((SELECT modseq FROM imap_mailbox_state WHERE mailbox_id = ?) + ?)", params: [mailboxId, offset] });

/** The same for UIDs: a batch that reserved `c` UIDs in the folder gives row `j` (0..c-1) the offset `j - c`. */
const uidAt = (mailboxId: string, folderKey: string, offset: number): Fragment => ({ sql: "((SELECT uid_next FROM imap_folder_state WHERE id = ?) + ?)", params: [`${mailboxId}:${folderKey}`, offset] });

/**
 * One atomic batch that reserves its numbers and uses them. The first statement
 * bumps the mailbox mod-sequence (row lock until commit), the next ones bump
 * `uid_next` of the folders that get new UIDs, in key order; every writer takes
 * the locks in that order, so writers wait for each other and cannot deadlock.
 */
function lockedBatch(env: SyncEnv, mailboxId: string, expectSeq: number | null, reserve: { modseq: number; uids?: Map<string, number> }, work: D1PreparedStatement[]) {
	const folders = [...(reserve.uids ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const guard = expectSeq === null ? null : staleGuard(env, mailboxId, expectSeq);
	return env.DB.batch([
		statement(env, "UPDATE imap_mailbox_state SET modseq = modseq + ? WHERE mailbox_id = ?", reserve.modseq, mailboxId),
		...(guard ? [guard.check] : []),
		...folders.map(([key, count]) => statement(env, "UPDATE imap_folder_state SET uid_next = uid_next + ? WHERE id = ?", count, `${mailboxId}:${key}`)),
		...work,
		...(guard ? [guard.clear] : []),
	]);
}

/**
 * Fails the batch, through a unique index, unless the mailbox is still at the
 * `jmap_seq` the plan was made from. It inserts two rows into `imap_uids` under a
 * folder key no real folder has: they collide (same UID) only when the state no
 * longer matches. If the guard passes, the last statement of the batch removes the
 * rows; if it fails, the batch rolls back and no row is left. No schema is needed:
 * `imap_uids` has no foreign keys and the guard key never matches a folder.
 */
function staleGuard(env: SyncEnv, mailboxId: string, expectSeq: number) {
	const key = `guard:${crypto.randomUUID()}`;
	return {
		check: statement(
			env,
			"INSERT INTO imap_uids (mailbox_id, folder_key, uid, message_id, modseq, content_hash) VALUES (?, ?, 1, 'a', 0, NULL), (?, ?, CASE WHEN EXISTS (SELECT 1 FROM imap_mailbox_state WHERE mailbox_id = ? AND jmap_seq = ?) THEN 2 ELSE 1 END, 'b', 0, NULL)",
			mailboxId, key, mailboxId, key, mailboxId, expectSeq,
		),
		clear: statement(env, "DELETE FROM imap_uids WHERE mailbox_id = ? AND folder_key = ?", mailboxId, key),
	};
}

/** A folder's highest mod-sequence only ever grows. */
function raiseHighest(env: SyncEnv, mailboxId: string, folderKey: string, offset: number) {
	const value = modseqAt(mailboxId, offset);
	return statement(env, `UPDATE imap_folder_state SET highest_modseq = ${value.sql} WHERE id = ? AND highest_modseq < ${value.sql}`, ...value.params, `${mailboxId}:${folderKey}`, ...value.params);
}

function expungeStatements(env: SyncEnv, mailboxId: string, folderKey: string, uid: number, modseqOffset: number) {
	const value = modseqAt(mailboxId, modseqOffset);
	return [
		statement(env, "DELETE FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND uid = ?", mailboxId, folderKey, uid),
		statement(env, `INSERT INTO imap_expunged (mailbox_id, folder_key, uid, modseq) VALUES (?, ?, ?, ${value.sql})`, mailboxId, folderKey, uid, ...value.params),
	];
}

type FolderRow = { uidNext: number; highestModseq: number };

/** Creates the folder's state on first use, with a UIDVALIDITY of now. */
async function ensureFolder(env: SyncEnv, mailboxId: string, folderKey: string, modseq: number): Promise<FolderRow> {
	await getDb(env).insert(imapFolderState).values({ id: `${mailboxId}:${folderKey}`, mailboxId, folderKey, uidvalidity: nowSeconds(), uidNext: 1, highestModseq: modseq }).onConflictDoNothing();
	const [row] = await rows<{ uid_next: number; highest_modseq: number }>(env, "SELECT uid_next, highest_modseq FROM imap_folder_state WHERE id = ?", `${mailboxId}:${folderKey}`);
	return { uidNext: num(row.uid_next), highestModseq: num(row.highest_modseq) };
}

/**
 * Throws FolderInconsistent when a UID in the folder is at or above `uid_next`,
 * which no writer of this code can produce. The cheap check reads the highest UID
 * first and `uid_next` second: a writer that commits in between only moves
 * `uid_next` further ahead, so contention cannot look like corruption. A suspected
 * inconsistency is read once more under the mailbox lock before anyone resets the folder.
 */
async function assertFolderConsistent(env: SyncEnv, mailboxId: string, folderKey: string): Promise<void> {
	const id = `${mailboxId}:${folderKey}`;
	const top = "SELECT max(uid) AS top FROM imap_uids WHERE mailbox_id = ? AND folder_key = ?";
	const next = "SELECT uid_next FROM imap_folder_state WHERE id = ?";
	const [highest] = await rows<{ top: number | null }>(env, top, mailboxId, folderKey);
	const [folder] = await rows<{ uid_next: number }>(env, next, id);
	if (!folder) throw new Error(`No IMAP state for folder ${id}`);
	if (num(highest?.top) < num(folder.uid_next)) return;
	const [, locked, again] = await env.DB.batch<{ top: number | null; uid_next: number }>([
		statement(env, "UPDATE imap_mailbox_state SET updated_at = updated_at WHERE mailbox_id = ?", mailboxId),
		statement(env, top, mailboxId, folderKey),
		statement(env, next, id),
	]);
	if (num(locked.results[0]?.top) >= num(again.results[0]?.uid_next)) throw new FolderInconsistent(mailboxId, folderKey);
}

/** Empties a folder and gives it a new UIDVALIDITY (always larger than the old one) so clients resync it. */
async function resetFolder(env: SyncEnv, mailboxId: string, folderKey: string): Promise<void> {
	const id = `${mailboxId}:${folderKey}`;
	const now = nowSeconds();
	const value = modseqAt(mailboxId, 0);
	await lockedBatch(env, mailboxId, null, { modseq: 1 }, [
		statement(env, "DELETE FROM imap_uids WHERE mailbox_id = ? AND folder_key = ?", mailboxId, folderKey),
		statement(env, "DELETE FROM imap_expunged WHERE mailbox_id = ? AND folder_key = ?", mailboxId, folderKey),
		// Decided under the lock, so a concurrent reset cannot lower it.
		statement(env, `UPDATE imap_folder_state SET uid_next = 1, uidvalidity = CASE WHEN uidvalidity + 1 > ? THEN uidvalidity + 1 ELSE ? END, highest_modseq = ${value.sql} WHERE id = ?`, now, now, ...value.params, id),
		// The folder is empty now; the next sync must refill it from the messages.
		statement(env, "UPDATE imap_mailbox_state SET jmap_seq = ? WHERE mailbox_id = ?", UNFINISHED, mailboxId),
	]);
}

// ---- Drafts ----

/**
 * SHA-256 of what the composer edits, so an autosave that changes the draft replaces its UID (spec 8.4).
 * It covers every column the synthesized bytes are built from (fetch.ts `contentKey`) and the attachments
 * still in the message, since a trashed attachment is left out of them.
 */
async function draftHashes(env: SyncEnv, ids: string[]): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	for (const chunk of chunks(ids, ID_CHUNK)) {
		const marks = placeholders(chunk.length);
		type DraftColumns = { id: string; from_addr: string; to_addr: string; cc_addr: string | null; bcc_addr: string | null; reply_to: string | null; subject: string | null; text_body: string | null; html_body: string | null; provider_message_id: string | null; in_reply_to: string | null; references_header: string | null };
		const messages = await rows<DraftColumns>(env, `SELECT id, from_addr, to_addr, cc_addr, bcc_addr, reply_to, subject, text_body, html_body, provider_message_id, in_reply_to, references_header FROM messages WHERE id IN (${marks})`, ...chunk);
		const attachments = await rows<{ message_id: string; id: string }>(env, `SELECT message_id, id FROM message_attachments WHERE message_id IN (${marks}) AND trashed_at IS NULL ORDER BY id`, ...chunk);
		for (const message of messages) {
			const attached = attachments.filter((attachment) => attachment.message_id === message.id).map((attachment) => attachment.id);
			const content = JSON.stringify([message.from_addr, message.to_addr, message.cc_addr, message.bcc_addr, message.reply_to, message.subject, message.text_body, message.html_body, message.provider_message_id, message.in_reply_to, message.references_header, attached]);
			const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
			hashes.set(message.id, [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
		}
	}
	return hashes;
}

// ---- Applying changes ----

type UidRow = { folder_key: string; uid: number; message_id: string; content_hash: string | null };
type NewUid = { folderKey: string; uidOffset: number; messageId: string; modseqOffset: number; hash: string | null };

function insertUidStatements(env: SyncEnv, mailboxId: string, items: NewUid[]) {
	return chunks(items, UID_ROWS_PER_INSERT).map((group) => {
		const values = group.map((item) => ({ uid: uidAt(mailboxId, item.folderKey, item.uidOffset), modseq: modseqAt(mailboxId, item.modseqOffset) }));
		return statement(
			env,
			`INSERT INTO imap_uids (mailbox_id, folder_key, uid, message_id, modseq, content_hash) VALUES ${values.map((value) => `(?, ?, ${value.uid.sql}, ?, ${value.modseq.sql}, ?)`).join(", ")}`,
			...group.flatMap((item, index) => [mailboxId, item.folderKey, ...values[index].uid.params, item.messageId, ...values[index].modseq.params, item.hash]),
		);
	});
}

const advanceTo = (env: SyncEnv, mailboxId: string, lastSeq: number) =>
	statement(env, "UPDATE imap_mailbox_state SET jmap_seq = ?, updated_at = ? WHERE mailbox_id = ? AND jmap_seq < ?", lastSeq, nowSeconds(), mailboxId, lastSeq);

/**
 * Applies the current state of the messages named by one slice of the change
 * log, then moves `jmap_seq` to the end of the slice, all in one batch. Only
 * the current row matters, not the kind of change: a message that is gone or
 * now lives in another mailbox is expunged, one in a new folder is expunged and
 * gets a new UID there, one in the same folder gets a new mod-sequence.
 */
async function applyChanges(env: SyncEnv, mailboxId: string, fromSeq: number, messageIds: string[], lastSeq: number): Promise<void> {
	const state = (await readState(env, mailboxId))!;
	const current = new Map<string, { mailboxId: string | null; folderId: string | null; status: string }>();
	const existing = new Map<string, UidRow[]>();
	for (const chunk of chunks(messageIds, ID_CHUNK)) {
		const marks = placeholders(chunk.length);
		for (const row of await rows<{ id: string; mailbox_id: string | null; folder_id: string | null; status: string }>(env, `SELECT id, mailbox_id, folder_id, status FROM messages WHERE mailbox_id = ? AND id IN (${marks})`, mailboxId, ...chunk)) {
			current.set(row.id, { mailboxId: row.mailbox_id, folderId: row.folder_id, status: row.status });
		}
		for (const row of await rows<UidRow>(env, `SELECT folder_key, uid, message_id, content_hash FROM imap_uids WHERE mailbox_id = ? AND message_id IN (${marks})`, mailboxId, ...chunk)) {
			existing.set(row.message_id, [...(existing.get(row.message_id) ?? []), row]);
		}
	}
	const target = new Map(messageIds.map((id) => [id, current.has(id) ? folderKeyOf(current.get(id)!) : null]));
	const hashes = await draftHashes(env, messageIds.filter((id) => target.get(id) === "drafts"));

	type Plan = { expunge: Array<{ key: string; uid: number }>; bump?: { key: string; uid: number; hash: string | null }; assign?: { key: string; hash: string | null }; dropCache: boolean };
	const plans = messageIds.map((id): [string, Plan] => {
		const key = target.get(id) ?? null;
		const hash = hashes.get(id) ?? null;
		const plan: Plan = { expunge: [], dropCache: false };
		let kept = false;
		for (const row of existing.get(id) ?? []) {
			const replaced = key === "drafts" && row.folder_key === "drafts" && row.content_hash !== null && row.content_hash !== hash;
			if (row.folder_key === key && !replaced) {
				plan.bump = { key: row.folder_key, uid: num(row.uid), hash: key === "drafts" ? hash : null };
				kept = true;
			} else {
				plan.expunge.push({ key: row.folder_key, uid: num(row.uid) });
				if (replaced) plan.dropCache = true;
			}
		}
		if (key && !kept) plan.assign = { key, hash };
		return [id, plan];
	});

	const modseqCount = plans.reduce((total, [, plan]) => total + plan.expunge.length + (plan.bump ? 1 : 0) + (plan.assign ? 1 : 0), 0);
	if (!modseqCount) {
		await lockedBatch(env, mailboxId, fromSeq, { modseq: 0 }, [advanceTo(env, mailboxId, lastSeq)]);
		return;
	}
	const newCounts = new Map<string, number>();
	for (const [, plan] of plans) if (plan.assign) newCounts.set(plan.assign.key, (newCounts.get(plan.assign.key) ?? 0) + 1);
	for (const key of newCounts.keys()) {
		await ensureFolder(env, mailboxId, key, state.modseq);
		await assertFolderConsistent(env, mailboxId, key);
	}
	// Offsets, not numbers: the batch's first statements reserve them and everything below is derived from the counters.
	let step = 0;
	const nextModseq = () => ++step - modseqCount;
	const used = new Map<string, number>();
	const highest = new Map<string, number>();
	const note = (key: string, offset: number) => highest.set(key, Math.max(highest.get(key) ?? -Infinity, offset));
	const deletes: D1PreparedStatement[] = [];
	const updates: D1PreparedStatement[] = [];
	const inserts: NewUid[] = [];
	for (const [id, plan] of plans) {
		for (const gone of plan.expunge) {
			const offset = nextModseq();
			deletes.push(...expungeStatements(env, mailboxId, gone.key, gone.uid, offset));
			note(gone.key, offset);
		}
		if (plan.dropCache) deletes.push(statement(env, "DELETE FROM imap_message_cache WHERE message_id = ?", id));
		if (plan.bump) {
			const offset = nextModseq();
			const value = modseqAt(mailboxId, offset);
			updates.push(statement(env, `UPDATE imap_uids SET modseq = ${value.sql}, content_hash = ? WHERE mailbox_id = ? AND folder_key = ? AND uid = ?`, ...value.params, plan.bump.hash, mailboxId, plan.bump.key, plan.bump.uid));
			note(plan.bump.key, offset);
		}
		if (plan.assign) {
			const offset = nextModseq();
			const index = used.get(plan.assign.key) ?? 0;
			used.set(plan.assign.key, index + 1);
			inserts.push({ folderKey: plan.assign.key, uidOffset: index - newCounts.get(plan.assign.key)!, messageId: id, modseqOffset: offset, hash: plan.assign.hash });
			note(plan.assign.key, offset);
		}
	}
	await lockedBatch(env, mailboxId, fromSeq, { modseq: modseqCount, uids: newCounts }, [
		...deletes,
		...updates,
		...insertUidStatements(env, mailboxId, inserts),
		// The folder row exists: it held the UIDs, or ensureFolder just made it.
		...[...highest].map(([key, offset]) => raiseHighest(env, mailboxId, key, offset)),
		advanceTo(env, mailboxId, lastSeq),
	]);
}

// ---- Full reconcile ----

/**
 * Brings one folder in line with the messages that match it: expunges UIDs without
 * a matching message (and drafts whose content changed while nobody was looking),
 * assigns UIDs to messages without one.
 */
async function reconcileFolder(env: SyncEnv, mailboxId: string, folderKey: string, marker: number): Promise<void> {
	const condition = folderKeyCondition(mailboxId, folderKey);
	if (!condition) return;
	const db = getDb(env);
	for (;;) {
		const stale = await db.all<{ uid: number }>(sql`SELECT uid FROM imap_uids WHERE mailbox_id = ${mailboxId} AND folder_key = ${folderKey} AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = imap_uids.message_id AND ${condition}) ORDER BY uid LIMIT ${SYNC_STEP}`);
		if (!stale.length) break;
		const work = stale.flatMap(({ uid }, index) => expungeStatements(env, mailboxId, folderKey, num(uid), index + 1 - stale.length));
		await lockedBatch(env, mailboxId, marker, { modseq: stale.length }, [...work, raiseHighest(env, mailboxId, folderKey, 0)]);
	}
	if (folderKey === "drafts") {
		// The change log that would have shown an autosave is gone: compare what the draft says now with the hash recorded for its UID.
		for (let cursor = 0; ; ) {
			const page = await rows<{ uid: number; message_id: string; content_hash: string }>(env, "SELECT uid, message_id, content_hash FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND uid > ? AND content_hash IS NOT NULL ORDER BY uid LIMIT ?", mailboxId, folderKey, cursor, SYNC_STEP);
			if (!page.length) break;
			cursor = num(page[page.length - 1].uid);
			const hashes = await draftHashes(env, page.map((row) => row.message_id));
			const changed = page.filter((row) => hashes.has(row.message_id) && hashes.get(row.message_id) !== row.content_hash);
			if (changed.length) {
				const work = changed.flatMap((row, index) => [...expungeStatements(env, mailboxId, folderKey, num(row.uid), index + 1 - changed.length), statement(env, "DELETE FROM imap_message_cache WHERE message_id = ?", row.message_id)]);
				await lockedBatch(env, mailboxId, marker, { modseq: changed.length }, [...work, raiseHighest(env, mailboxId, folderKey, 0)]);
			}
			if (page.length < SYNC_STEP) break;
		}
	}
	for (;;) {
		const missing = await db.all<{ id: string }>(sql`SELECT messages.id AS id FROM messages WHERE ${condition} AND NOT EXISTS (SELECT 1 FROM imap_uids WHERE imap_uids.mailbox_id = ${mailboxId} AND imap_uids.folder_key = ${folderKey} AND imap_uids.message_id = messages.id) ORDER BY messages.created_at, messages.id LIMIT ${RECONCILE_CHUNK}`);
		if (!missing.length) break;
		const ids = missing.map((row) => row.id);
		const hashes = folderKey === "drafts" ? await draftHashes(env, ids) : new Map<string, string>();
		await assertFolderConsistent(env, mailboxId, folderKey);
		const items = ids.map((id, index): NewUid => ({ folderKey, uidOffset: index - ids.length, messageId: id, modseqOffset: index + 1 - ids.length, hash: hashes.get(id) ?? null }));
		await lockedBatch(env, mailboxId, marker, { modseq: ids.length, uids: new Map([[folderKey, ids.length]]) }, [...insertUidStatements(env, mailboxId, items), raiseHighest(env, mailboxId, folderKey, 0)]);
	}
}

/**
 * Rebuilds a mailbox's UID map from its messages: the first sync ever, and any
 * sync whose saved position is below the change floor (the retention job dropped
 * changes it never saw). In the second case flag changes may have been missed
 * too, so every existing UID gets one new mod-sequence and clients refetch flags.
 */
async function reconcile(env: SyncEnv, mailboxId: string, state: State | null): Promise<void> {
	const db = getDb(env);
	// Read before scanning: changes made during the scan are applied by the next incremental sync.
	// Only this mailbox's changes count; the log is shared and other mailboxes' sequence numbers say nothing about it.
	const [top] = await rows<{ top: number | null }>(env, "SELECT max(seq) AS top FROM jmap_changes WHERE mailbox_id = ?", mailboxId);
	const position = Math.max(num(top?.top), await readFloor(env));
	if (!state) await db.insert(imapMailboxState).values({ mailboxId, jmapSeq: UNFINISHED, modseq: 1 }).onConflictDoNothing();
	const fresh = (await readState(env, mailboxId))!;
	const userFolders = await rows<{ id: string }>(env, "SELECT id FROM folders WHERE mailbox_id = ?", mailboxId);
	const keys = [...SYSTEM_ROLES, ...userFolders.map((folder) => `f:${folder.id}`)];
	// Folders deleted while nobody was looking: their state goes, their messages are in other folders now.
	const known = await rows<{ folder_key: string }>(env, "SELECT folder_key FROM imap_folder_state WHERE mailbox_id = ?", mailboxId);
	for (const { folder_key: gone } of known.filter((folder) => !keys.includes(folder.folder_key))) {
		await lockedBatch(env, mailboxId, fresh.jmapSeq, { modseq: 0 }, [
			statement(env, "DELETE FROM imap_uids WHERE mailbox_id = ? AND folder_key = ?", mailboxId, gone),
			statement(env, "DELETE FROM imap_expunged WHERE mailbox_id = ? AND folder_key = ?", mailboxId, gone),
			statement(env, "DELETE FROM imap_folder_state WHERE id = ?", `${mailboxId}:${gone}`),
		]);
	}
	if (state && state.jmapSeq !== UNFINISHED) {
		// In bounded slices (a mailbox can hold millions of UIDs); each slice has its own, later mod-sequence. A crash part way leaves the position below the floor, so the next sync does it again.
		for (const { folder_key: key } of known.filter((folder) => keys.includes(folder.folder_key))) {
			for (let cursor = 0; ; ) {
				const page = await rows<{ uid: number }>(env, "SELECT uid FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND uid > ? ORDER BY uid LIMIT ?", mailboxId, key, cursor, BUMP_CHUNK);
				if (!page.length) break;
				const last = num(page[page.length - 1].uid);
				const value = modseqAt(mailboxId, 0);
				await lockedBatch(env, mailboxId, fresh.jmapSeq, { modseq: 1 }, [
					statement(env, `UPDATE imap_uids SET modseq = ${value.sql} WHERE mailbox_id = ? AND folder_key = ? AND uid > ? AND uid <= ?`, ...value.params, mailboxId, key, cursor, last),
					raiseHighest(env, mailboxId, key, 0),
				]);
				cursor = last;
				if (page.length < BUMP_CHUNK) break;
			}
		}
	}
	for (const key of keys) {
		await ensureFolder(env, mailboxId, key, fresh.modseq);
		await reconcileFolder(env, mailboxId, key, fresh.jmapSeq);
	}
	await lockedBatch(env, mailboxId, fresh.jmapSeq, { modseq: 0 }, [advanceTo(env, mailboxId, position)]);
}

// ---- Entry points ----

async function syncOnce(env: SyncEnv, mailboxId: string): Promise<void> {
	const state = await readState(env, mailboxId);
	if (!state || state.jmapSeq < (await readFloor(env))) return reconcile(env, mailboxId, state);
	let seq = state.jmapSeq;
	for (;;) {
		const changes = await rows<{ seq: number; object_type: string; object_id: string }>(env, "SELECT seq, object_type, object_id FROM jmap_changes WHERE mailbox_id = ? AND seq > ? ORDER BY seq LIMIT ?", mailboxId, seq, SYNC_STEP);
		// The retention job may have dropped changes between `seq` and the floor before this slice was read, so the slice can have holes.
		if ((await readFloor(env)) > seq) return reconcile(env, mailboxId, await readState(env, mailboxId));
		if (!changes.length) return;
		const lastSeq = num(changes[changes.length - 1].seq);
		const messageIds = [...new Set(changes.filter((change) => change.object_type === "email").map((change) => change.object_id))];
		await applyChanges(env, mailboxId, seq, messageIds, lastSeq);
		seq = lastSeq;
		if (changes.length < SYNC_STEP) return;
	}
}

/** Like `syncMailbox` without the in-process mutex; exported so tests can race two of them. */
export async function syncMailboxUnserialized(env: SyncEnv, mailboxId: string): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await syncOnce(env, mailboxId);
		} catch (error) {
			if (attempt >= MAX_ATTEMPTS) throw error;
			if (error instanceof FolderInconsistent) await resetFolder(env, error.mailboxId, error.folderKey);
			else if (!isRetryableConflictError(error)) throw error;
		}
	}
}

const running = new Map<string, Promise<void>>();

/**
 * Brings the IMAP state of one Mailflare mailbox up to date with its messages.
 * Callers: SELECT/EXAMINE/STATUS/NOOP/CHECK, after the session's own mutations
 * and on IDLE wake-ups (F8-3 and later). Concurrent calls for one mailbox queue.
 */
export function syncMailbox(env: SyncEnv, mailboxId: string): Promise<void> {
	const next = (running.get(mailboxId) ?? Promise.resolve()).catch(() => undefined).then(() => syncMailboxUnserialized(env, mailboxId));
	running.set(mailboxId, next);
	next.then(() => undefined, () => undefined).then(() => {
		if (running.get(mailboxId) === next) running.delete(mailboxId);
	});
	return next;
}

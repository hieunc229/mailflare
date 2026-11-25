import { and, asc, eq, gt, inArray, not, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { jmapChangeFloor, jmapChanges, mailboxPromotionSettings, messages } from "@/db/schema";
import { greatest } from "@/db/sql";
import { DRAFT_FILTER_PARAMS, draftsVisibleTo } from "@/lib/email/draft-access";
import { isMissingTableError } from "@/lib/database-errors";
import { listFoldersByMailbox, listJmapMailboxes } from "./access";
import { encodeMailboxRef, SYSTEM_ROLES } from "./ids";
import type { AccessibleMailbox, JmapContext } from "./types";
import { coalesceChanges, formatState, parseState } from "./changes-utils";

/**
 * States are `c1:<seq>:<access>`: the newest change-log sequence among the
 * account's mailboxes, plus a fingerprint of which mailboxes it can see and
 * how, and which of them show `$promotion` (Promotions mode not off). A sharing
 * change or a mode flip alters the fingerprint, so a `Foo/changes` call from an older
 * state answers `cannotCalculateChanges` and the client resyncs. A mode flip writes no
 * change-log row, so the fingerprint is the only way clients learn the keyword moved.
 */
async function accessFingerprint(ctx: JmapContext, mailboxes: AccessibleMailbox[]): Promise<string> {
	const promoting = await promotingMailboxIds(ctx, new Set(mailboxes.map((m) => m.id)));
	const material = JSON.stringify([mailboxes.map((m) => [m.id, m.permission]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), promoting]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
	return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sorted ids, among `accessible`, whose Promotions mode is not off. One unbound query: the table holds a row per mailbox at most. */
async function promotingMailboxIds(ctx: JmapContext, accessible: Set<string>): Promise<string[]> {
	try {
		const rows = await ctx.db.select({ id: mailboxPromotionSettings.mailboxId }).from(mailboxPromotionSettings).where(sql`${mailboxPromotionSettings.mode} <> 'off'`);
		return rows.map((row) => row.id).filter((id) => accessible.has(id)).sort();
	} catch (error) {
		if (isMissingTableError(error)) return [];
		throw error;
	}
}

async function floorSeq(ctx: JmapContext): Promise<number> {
	const [row] = await ctx.db.select({ seq: jmapChangeFloor.seq }).from(jmapChangeFloor).where(eq(jmapChangeFloor.id, 1)).limit(1);
	return row?.seq ?? 0;
}

/**
 * Newest sequence per mailbox, one indexed MAX per mailbox. D1 allows at most 5 terms in a
 * compound SELECT, so the chunks run concurrently: one after another costs a round trip each.
 */
async function latestSeq(ctx: JmapContext, mailboxIds: string[]): Promise<number> {
	const chunks: string[][] = [];
	for (let offset = 0; offset < mailboxIds.length; offset += 5) chunks.push(mailboxIds.slice(offset, offset + 5));
	const results = await Promise.all(
		chunks.map((chunk) =>
			ctx.db.all<{ seq: number | null }>(sql.join(chunk.map((id) => sql`SELECT (SELECT max(seq) FROM jmap_changes WHERE mailbox_id = ${id}) AS seq`), sql` UNION ALL `)),
		),
	);
	return Math.max(0, ...results.flat().map((row) => row.seq ?? 0));
}

export type ChangeScope = {
	mailboxes: AccessibleMailbox[];
	seq: number;
	fingerprint: string;
	state: string;
};

export function currentChangeScope(ctx: JmapContext): Promise<ChangeScope> {
	if (ctx.memo === null) return loadChangeScope(ctx);
	const memo = (ctx.memo ??= {});
	if (!memo.scope) {
		const pending = loadChangeScope(ctx);
		memo.scope = pending;
		pending.catch(() => {
			if (memo.scope === pending) memo.scope = undefined;
		});
	}
	return memo.scope;
}

async function loadChangeScope(ctx: JmapContext): Promise<ChangeScope> {
	const mailboxes = await listJmapMailboxes(ctx);
	const [seq, fingerprint, floor] = await Promise.all([latestSeq(ctx, mailboxes.map((m) => m.id)), accessFingerprint(ctx, mailboxes), floorSeq(ctx)]);
	const effective = Math.max(seq, floor);
	return { mailboxes, seq: effective, fingerprint, state: formatState(effective, fingerprint) };
}

type ChangeRow = { seq: number; mailboxId: string; objectType: string; objectId: string; threadId: string | null; change: string };

/**
 * Log rows after `sinceState`, or null when the state cannot be continued
 * from (unknown format, pruned history, or the account's access changed).
 */
async function rowsSince(
	ctx: JmapContext,
	sinceState: unknown,
	objectType: "email" | "mailbox" | null,
	limit: number,
): Promise<{ scope: ChangeScope; rows: ChangeRow[]; hasMore: boolean; lastSeq: number } | null> {
	const since = parseState(sinceState);
	const scope = await currentChangeScope(ctx);
	if (!since || since.fingerprint !== scope.fingerprint || since.seq > scope.seq) return null;
	if (since.seq < (await floorSeq(ctx))) return null;
	const ids = scope.mailboxes.map((m) => m.id);
	if (ids.length === 0) return { scope, rows: [], hasMore: false, lastSeq: scope.seq };
	const conditions = [inArray(jmapChanges.mailboxId, ids), gt(jmapChanges.seq, since.seq)];
	if (objectType) conditions.push(eq(jmapChanges.objectType, objectType));
	const rows = await ctx.db
		.select({
			seq: jmapChanges.seq,
			mailboxId: jmapChanges.mailboxId,
			objectType: jmapChanges.objectType,
			objectId: jmapChanges.objectId,
			threadId: jmapChanges.threadId,
			change: jmapChanges.change,
		})
		.from(jmapChanges)
		.where(and(...conditions))
		.orderBy(asc(jmapChanges.seq))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	// Paging continues from the last logged change, whether or not this account may see it.
	const lastSeq = page.length ? page[page.length - 1].seq : scope.seq;
	return { scope, rows: await withoutOthersDrafts(ctx, page), hasMore, lastSeq };
}

/**
 * Other users' drafts in a shared mailbox are private, so their ids stay out of the email feeds and
 * their activity does not mark the mailbox as changed. Two cases need care:
 *  - a message that was visible and became a draft (a scheduled send cancelled back to Drafts, a
 *    status change or a JMAP move into Drafts) is logged with a "hidden" marker (logMessageHidden): readers who can no longer see it are told it was destroyed,
 *    its author just sees an update;
 *  - a draft that has since been deleted can no longer be told apart; its (random) id is still
 *    reported as destroyed.
 */
async function withoutOthersDrafts(ctx: JmapContext, rows: ChangeRow[]): Promise<ChangeRow[]> {
	const ids = [...new Set(rows.filter((row) => row.objectType === "email").map((row) => row.objectId))];
	if (ids.length === 0) return rows;
	const hidden = new Set<string>();
	// D1 allows 100 bound parameters per statement; the draft filter takes some of them.
	const batch = 100 - DRAFT_FILTER_PARAMS;
	for (let offset = 0; offset < ids.length; offset += batch) {
		const found = await ctx.db
			.select({ id: messages.id })
			.from(messages)
			.where(and(inArray(messages.id, ids.slice(offset, offset + batch)), not(draftsVisibleTo(ctx.auth.userId))));
		for (const row of found) hidden.add(row.id);
	}
	const result: ChangeRow[] = [];
	for (const row of rows) {
		if (row.objectType !== "email") result.push(row);
		else if (row.change === "hidden") result.push({ ...row, change: hidden.has(row.objectId) ? "destroyed" : "updated" });
		else if (!hidden.has(row.objectId)) result.push(row);
	}
	return result;
}

function maxChangesOf(args: Record<string, unknown>): number {
	const requested = typeof args.maxChanges === "number" && args.maxChanges > 0 ? Math.floor(args.maxChanges) : 500;
	return Math.min(requested, 5000);
}

function cannot() {
	return { type: "cannotCalculateChanges", description: "The state is too old or access changed; fetch again." };
}

export async function emailChangesSince(ctx: JmapContext, args: Record<string, unknown>) {
	const limit = maxChangesOf(args);
	const result = await rowsSince(ctx, args.sinceState, "email", limit);
	if (!result) return cannot();
	const { created, updated, destroyed } = coalesceChanges(result.rows.map((row) => ({ id: row.objectId, change: row.change })));
	const newState = result.hasMore ? formatState(result.lastSeq, result.scope.fingerprint) : result.scope.state;
	return { accountId: ctx.accountId, oldState: args.sinceState, newState, hasMoreChanges: result.hasMore, created, updated, destroyed };
}

/**
 * Threads touched since the state. A thread whose messages are all gone is
 * destroyed; one first seen in this window is created; the rest are updated.
 */
export async function threadChangesSince(ctx: JmapContext, args: Record<string, unknown>) {
	const limit = maxChangesOf(args);
	const result = await rowsSince(ctx, args.sinceState, "email", limit);
	if (!result) return cannot();
	const firstChange = new Map<string, string>();
	for (const row of result.rows) {
		const thread = row.threadId ?? row.objectId;
		if (!firstChange.has(thread)) firstChange.set(thread, row.change);
	}
	const threads = Array.from(firstChange.keys());
	const ids = result.scope.mailboxes.map((m) => m.id);
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;
	const alive = new Set<string>();
	// D1 allows 100 bound parameters per statement: the mailbox ids and the draft filter share them with the thread ids.
	const threadChunk = Math.max(1, 100 - ids.length - DRAFT_FILTER_PARAMS);
	for (let offset = 0; offset < threads.length; offset += threadChunk) {
		const chunk = threads.slice(offset, offset + threadChunk);
		const rows = await ctx.db
			.selectDistinct({ thread: threadKey })
			.from(messages)
			.where(and(inArray(threadKey, chunk), inArray(messages.mailboxId, ids), draftsVisibleTo(ctx.auth.userId)));
		for (const row of rows) alive.add(row.thread);
	}
	const created: string[] = [];
	const updated: string[] = [];
	const destroyed: string[] = [];
	for (const [thread, first] of firstChange) {
		if (!alive.has(thread)) destroyed.push(thread);
		else if (first === "created" && result.rows.every((row) => (row.threadId ?? row.objectId) !== thread || row.change === "created")) created.push(thread);
		else updated.push(thread);
	}
	const newState = result.hasMore ? formatState(result.lastSeq, result.scope.fingerprint) : result.scope.state;
	return { accountId: ctx.accountId, oldState: args.sinceState, newState, hasMoreChanges: result.hasMore, created, updated, destroyed };
}

/**
 * Mailbox changes. Any message change alters counts, so every JMAP mailbox of
 * a touched address is reported updated; folder rows add creations and
 * deletions.
 */
export async function mailboxChangesSince(ctx: JmapContext, args: Record<string, unknown>) {
	const limit = maxChangesOf(args) * 20;
	const result = await rowsSince(ctx, args.sinceState, null, limit);
	if (!result) return cannot();
	const touched = new Set<string>();
	const folderChanges: Array<{ id: string; change: string }> = [];
	for (const row of result.rows) {
		touched.add(row.mailboxId);
		if (row.objectType === "mailbox" && row.objectId !== row.mailboxId) {
			folderChanges.push({ id: encodeMailboxRef({ kind: "folder", mailboxId: row.mailboxId, folderId: row.objectId }), change: row.change });
		}
	}
	const { created, updated, destroyed } = coalesceChanges(folderChanges);
	const reported = new Set([...created, ...updated, ...destroyed]);
	const folders = await listFoldersByMailbox(ctx, [...touched]);
	for (const mailboxId of touched) {
		const all = [
			encodeMailboxRef({ kind: "account", mailboxId }),
			...SYSTEM_ROLES.map((role) => encodeMailboxRef({ kind: "role", mailboxId, role })),
			...(folders.get(mailboxId) ?? []).map((folder) => encodeMailboxRef({ kind: "folder", mailboxId, folderId: folder.id })),
		];
		for (const id of all) {
			if (!reported.has(id)) {
				updated.push(id);
				reported.add(id);
			}
		}
	}
	const newState = result.hasMore ? formatState(result.lastSeq, result.scope.fingerprint) : result.scope.state;
	return { accountId: ctx.accountId, oldState: args.sinceState, newState, hasMoreChanges: result.hasMore, updatedProperties: null, created, updated, destroyed };
}

/** Change-log retention. Clients older than this resync from scratch. */
export const CHANGE_RETENTION_DAYS = 30;

/** Prunes old change rows and raises the floor; run from the daily cron. */
export async function pruneJmapChanges(db: AppDatabase, now = Date.now()): Promise<number> {
	const cutoff = Math.floor(now / 1000) - CHANGE_RETENTION_DAYS * 86400;
	const [row] = await db.all<{ seq: number | null }>(sql`SELECT max(seq) AS seq FROM jmap_changes WHERE created_at < ${cutoff}`);
	const floor = row?.seq ?? 0;
	if (!floor) return 0;
	await db.run(sql`UPDATE jmap_change_floor SET seq = ${greatest(sql`seq`, floor)} WHERE id = 1`);
	const deleted = await db.run(sql`DELETE FROM jmap_changes WHERE seq <= ${floor}`);
	return Number((deleted as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export async function runJmapChangeRetention(env: CloudflareEnv, now: Date): Promise<void> {
	await pruneJmapChanges(getDb(env), now.getTime());
}

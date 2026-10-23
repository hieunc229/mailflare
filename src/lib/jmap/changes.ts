import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { jmapChangeFloor, jmapChanges, messages } from "@/db/schema";
import { listFoldersByMailbox, listJmapMailboxes } from "./access";
import { encodeMailboxRef, SYSTEM_ROLES } from "./ids";
import type { AccessibleMailbox, JmapContext } from "./types";
import { coalesceChanges, formatState, parseState } from "./changes-utils";

/**
 * States are `c1:<seq>:<access>`: the newest change-log sequence among the
 * account's mailboxes, plus a fingerprint of which mailboxes it can see and
 * how. A sharing change alters the fingerprint, so a `Foo/changes` call from an older
 * state answers `cannotCalculateChanges` and the client resyncs.
 */
async function accessFingerprint(mailboxes: AccessibleMailbox[]): Promise<string> {
	const material = JSON.stringify(mailboxes.map((m) => [m.id, m.permission]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
	return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function floorSeq(ctx: JmapContext): Promise<number> {
	const [row] = await ctx.db.select({ seq: jmapChangeFloor.seq }).from(jmapChangeFloor).where(eq(jmapChangeFloor.id, 1)).limit(1);
	return row?.seq ?? 0;
}

/** Newest sequence per mailbox, one indexed MAX per mailbox. */
async function latestSeq(ctx: JmapContext, mailboxIds: string[]): Promise<number> {
	let latest = 0;
	for (let offset = 0; offset < mailboxIds.length; offset += 50) {
		const chunk = mailboxIds.slice(offset, offset + 50);
		const parts = chunk.map((id) => sql`SELECT (SELECT max(seq) FROM jmap_changes WHERE mailbox_id = ${id}) AS seq`);
		const rows = await ctx.db.all<{ seq: number | null }>(sql.join(parts, sql` UNION ALL `));
		for (const row of rows) latest = Math.max(latest, row.seq ?? 0);
	}
	return latest;
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
	const [seq, fingerprint, floor] = await Promise.all([latestSeq(ctx, mailboxes.map((m) => m.id)), accessFingerprint(mailboxes), floorSeq(ctx)]);
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
): Promise<{ scope: ChangeScope; rows: ChangeRow[]; hasMore: boolean } | null> {
	const since = parseState(sinceState);
	const scope = await currentChangeScope(ctx);
	if (!since || since.fingerprint !== scope.fingerprint || since.seq > scope.seq) return null;
	if (since.seq < (await floorSeq(ctx))) return null;
	const ids = scope.mailboxes.map((m) => m.id);
	if (ids.length === 0) return { scope, rows: [], hasMore: false };
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
	return { scope, rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
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
	const newState = result.hasMore ? formatState(result.rows[result.rows.length - 1].seq, result.scope.fingerprint) : result.scope.state;
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
	for (let offset = 0; offset < threads.length; offset += 100) {
		const chunk = threads.slice(offset, offset + 100);
		const rows = await ctx.db
			.selectDistinct({ thread: threadKey })
			.from(messages)
			.where(and(inArray(threadKey, chunk), inArray(messages.mailboxId, ids)));
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
	const newState = result.hasMore ? formatState(result.rows[result.rows.length - 1].seq, result.scope.fingerprint) : result.scope.state;
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
	const newState = result.hasMore ? formatState(result.rows[result.rows.length - 1].seq, result.scope.fingerprint) : result.scope.state;
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
	await db.run(sql`UPDATE jmap_change_floor SET seq = max(seq, ${floor}) WHERE id = 1`);
	const deleted = await db.run(sql`DELETE FROM jmap_changes WHERE seq <= ${floor}`);
	return Number((deleted as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export async function runJmapChangeRetention(env: CloudflareEnv, now: Date): Promise<void> {
	await pruneJmapChanges(getDb(env), now.getTime());
}

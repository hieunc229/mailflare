import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { mailboxSenderPreferences, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { isMissingTableError } from "@/lib/database-errors";
import { getEmailDisplayName } from "@/lib/email/address";
import { senderSweepCondition } from "@/lib/email/sender-sweep";
import { chunk, isStillSending, MAX_SWEEP_ROWS, SUBSCRIPTION_WINDOW_DAYS, SUBSCRIPTIONS_PAGE_SIZE, SWEEP_CHUNK_SIZE, SWEEP_WINDOW_DAYS, windowStart } from "@/lib/promotions/subscriptions-utils";

type Db = ReturnType<typeof getDb>;

export type SubscriptionRow = {
	senderAddress: string;
	displayName: string;
	total: number;
	lastReceived: Date;
	readCount: number;
	/** Whole percent of the sender's messages in the window that were read. */
	readRate: number;
	latestMessageId: string | null;
	canUnsubscribe: boolean;
	categoryOverride: "inbox" | "promotions" | null;
	unsubscribedAt: Date | null;
	stillSending: boolean;
};

/** Constants written as SQL literals so each statement binds as few parameters as possible. */
const notTrashOrSpam = sql`${messages.status} not in ('trash', 'spam')`;
const inbound = sql`${messages.direction} = 'inbound'`;

function promotionsWindow(mailboxId: string, now: Date) {
	return and(
		eq(messages.mailboxId, mailboxId),
		inbound,
		eq(messages.category, "promotions"),
		isNotNull(messages.senderAddress),
		notTrashOrSpam,
		gte(messages.createdAt, windowStart(now, SUBSCRIPTION_WINDOW_DAYS)),
	);
}

/** One page of promotional senders of a mailbox for the last 90 days, ranked by volume then recency. */
export async function listSubscriptions(db: Db, input: { mailboxId: string; offset: number; limit: number; now?: Date }): Promise<{ senders: SubscriptionRow[]; total: number }> {
	const now = input.now ?? new Date();
	const limit = Math.min(input.limit, SUBSCRIPTIONS_PAGE_SIZE);
	const where = promotionsWindow(input.mailboxId, now);
	const total = max(messages.createdAt);
	const [groups, [{ senders }]] = await Promise.all([
		db.select({
			senderAddress: messages.senderAddress,
			total: count(),
			lastReceived: total,
			readCount: sql<number>`sum(case when ${messages.read} then 1 else 0 end)`,
		}).from(messages).where(where).groupBy(messages.senderAddress)
			.orderBy(desc(count()), desc(total), asc(messages.senderAddress)).limit(limit).offset(input.offset),
		db.select({ senders: countDistinct(messages.senderAddress) }).from(messages).where(where),
	]);
	if (groups.length === 0) return { senders: [], total: Number(senders) };

	const addresses = groups.map((group) => group.senderAddress!);
	// One batch, one round trip on D1: the newest message of each sender that is neither spam nor trash.
	const latest = (await db.batch(addresses.map((address) => db.select({ id: messages.id, fromAddr: messages.fromAddr, hasUnsubscribe: messages.hasUnsubscribe })
		.from(messages)
		.where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.senderAddress, address), inbound, notTrashOrSpam))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(1)) as never)) as Array<Array<{ id: string; fromAddr: string; hasUnsubscribe: boolean }>>;
	const preferences = await loadPreferences(db, input.mailboxId, addresses);

	return {
		total: Number(senders),
		senders: groups.map((group, index): SubscriptionRow => {
			const address = group.senderAddress!;
			const newest = latest[index]?.[0];
			const preference = preferences.get(address);
			const lastReceived = new Date(group.lastReceived as Date);
			const readCount = Number(group.readCount ?? 0);
			const unsubscribedAt = preference?.unsubscribedAt ?? null;
			return {
				senderAddress: address,
				displayName: newest ? getEmailDisplayName(newest.fromAddr) : address,
				total: group.total,
				lastReceived,
				readCount,
				readRate: Math.round((readCount / group.total) * 100),
				latestMessageId: newest?.id ?? null,
				canUnsubscribe: newest?.hasUnsubscribe === true,
				categoryOverride: preference?.categoryOverride ?? null,
				unsubscribedAt,
				stillSending: isStillSending(lastReceived, unsubscribedAt),
			};
		}),
	};
}

/** Overrides and unsubscribe records for one page: mailbox plus at most 50 addresses is 51 binds. */
async function loadPreferences(db: Db, mailboxId: string, addresses: string[]) {
	type Preference = { senderAddress: string; categoryOverride: "inbox" | "promotions" | null; unsubscribedAt: Date | null };
	try {
		const rows = await db.select({
			senderAddress: mailboxSenderPreferences.senderAddress,
			categoryOverride: mailboxSenderPreferences.categoryOverride,
			unsubscribedAt: mailboxSenderPreferences.unsubscribedAt,
		}).from(mailboxSenderPreferences).where(and(eq(mailboxSenderPreferences.mailboxId, mailboxId), inArray(mailboxSenderPreferences.senderAddress, addresses)));
		return new Map<string, Preference>(rows.map((row) => [row.senderAddress, row]));
	} catch (error) {
		if (isMissingTableError(error)) return new Map<string, Preference>();
		throw error;
	}
}

/** What "Trash all" would do: rows of the last 90 days (at most 500 move per request) and the rows older than that, which stay. */
export async function previewSenderTrash(db: Db, input: { mailboxId: string; senderAddress: string; now?: Date }) {
	const since = windowStart(input.now ?? new Date(), SWEEP_WINDOW_DAYS);
	const base = senderSweepCondition(input.mailboxId, input.senderAddress);
	const [[recent], [older]] = await Promise.all([
		db.select({ n: count() }).from(messages).where(and(base, gte(messages.createdAt, since))),
		db.select({ n: count() }).from(messages).where(and(base, sql`${messages.createdAt} < ${since}`)),
	]);
	return { count: Number(recent.n), willChange: Math.min(Number(recent.n), MAX_SWEEP_ROWS), olderLeft: Number(older.n) };
}

/**
 * Moves a sender's newest MAX_SWEEP_ROWS rows of the last 90 days to Trash: ids selected first, then updated in
 * chunks under D1's parameter limit. The update repeats the sweep condition, so a row starred, filed or trashed in
 * between is neither written nor counted. `remaining` is every row of the sender the sweep still matches.
 */
export async function trashSenderMessages(db: Db, input: { mailboxId: string; senderAddress: string; now?: Date }): Promise<{ changed: number; remaining: number }> {
	const since = windowStart(input.now ?? new Date(), SWEEP_WINDOW_DAYS);
	const where = senderSweepCondition(input.mailboxId, input.senderAddress);
	const candidates = await db.select({ id: messages.id }).from(messages)
		.where(and(where, gte(messages.createdAt, since)))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(MAX_SWEEP_ROWS);
	let changed = 0;
	for (const ids of chunk(candidates.map((row) => row.id), SWEEP_CHUNK_SIZE)) {
		const updated = await db.update(messages).set({ status: "trash" }).where(and(inArray(messages.id, ids), where)).returning({ id: messages.id });
		changed += updated.length;
	}
	const [{ n }] = await db.select({ n: count() }).from(messages).where(where);
	return { changed, remaining: Number(n) };
}

/** Remembers that the user unsubscribed from this sender. Never throws: a missing table or any failure must not undo the unsubscribe. */
export async function recordUnsubscribed(db: Db, input: { mailboxId: string; senderAddress: string; userId: string; now?: Date }): Promise<void> {
	const unsubscribedAt = input.now ?? new Date();
	try {
		await db.insert(mailboxSenderPreferences)
			.values({ id: newId("msp"), mailboxId: input.mailboxId, senderAddress: input.senderAddress, unsubscribedAt, updatedByUserId: input.userId, updatedAt: unsubscribedAt })
			.onConflictDoUpdate({ target: [mailboxSenderPreferences.mailboxId, mailboxSenderPreferences.senderAddress], set: { unsubscribedAt, updatedAt: unsubscribedAt } });
	} catch (error) {
		if (!isMissingTableError(error)) console.error(`Recording unsubscribe failed for mailbox ${input.mailboxId}`, error);
	}
}

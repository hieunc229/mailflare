import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, gte, ne, or, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, mailboxPromotionSettings, mailboxSenderPreferences, messages } from "@/db/schema";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { detectBulkMail } from "@/lib/email/bulk-mail";
import { readHeaderMap } from "@/lib/email/provider-trace";
import { decideCategory, toSenderAddress } from "@/lib/promotions/classify-utils";
import { BACKFILL_BATCH, BACKFILL_CHUNK, BACKFILL_DAILY_CAP, BACKFILL_HEAD_BYTES, BACKFILL_MAX_STALLS, BACKFILL_STALE_MS, BACKFILL_WINDOW_DAYS, backfillCutoff, backfillDay, parseCursor, serializeCursor, type BackfillCursor } from "@/lib/promotions/backfill-utils";
import { chunk } from "@/lib/promotions/refile-utils";

export { BACKFILL_BATCH, BACKFILL_DAILY_CAP, BACKFILL_HEAD_BYTES, BACKFILL_WINDOW_DAYS };

type Db = ReturnType<typeof getDb>;
export type BackfillClaim = { mailboxId: string; cursor: BackfillCursor | null; scanned: number; claimedAt: Date; dayRows: number };
export type BackfillResult = { claimed: boolean; scanned: number; promoted: number };

const NOT_CLAIMED: BackfillResult = { claimed: false, scanned: 0, promoted: 0 };

/**
 * Takes one mailbox's job: `pending`, or `running` but untouched for 15 minutes (its run died), and only while the
 * mode is not off. The candidate is selected first, then claimed with a conditional UPDATE on its status and
 * `updated_at`, so overlapping runs cannot both win (the affected-row count must be 1). A takeover that finds
 * the stall counter at 3 marks the job failed instead of retrying it forever.
 *
 * `backfill_stalls` counts claims that saved no progress: every claim adds one, every saved chunk resets it to 0.
 * Seeing it above 0 at takeover therefore means the previous run died before saving anything.
 */
export async function claimBackfill(db: Db, now: Date): Promise<BackfillClaim | null> {
	const today = backfillDay(now);
	const staleBefore = new Date(now.getTime() - BACKFILL_STALE_MS);
	let candidate;
	try {
		[candidate] = await db.select().from(mailboxPromotionSettings)
			.where(and(
				ne(mailboxPromotionSettings.mode, "off"),
				or(eq(mailboxPromotionSettings.backfillStatus, "pending"), and(eq(mailboxPromotionSettings.backfillStatus, "running"), lt(mailboxPromotionSettings.updatedAt, staleBefore))),
			))
			.orderBy(asc(mailboxPromotionSettings.updatedAt))
			.limit(1);
	} catch (error) {
		// Before the migration there is no table (or column) and nothing to do.
		if (isMissingTableError(error) || isMissingColumnError(error)) return null;
		throw error;
	}
	if (!candidate) return null;

	const expected = and(
		eq(mailboxPromotionSettings.mailboxId, candidate.mailboxId),
		eq(mailboxPromotionSettings.backfillStatus, candidate.backfillStatus),
		eq(mailboxPromotionSettings.updatedAt, candidate.updatedAt),
	);
	if (candidate.backfillStatus === "running" && candidate.backfillStalls >= BACKFILL_MAX_STALLS) {
		const error = `Promotions backfill made no progress in ${BACKFILL_MAX_STALLS} consecutive runs and was stopped`;
		const failed = await db.update(mailboxPromotionSettings).set({ backfillStatus: "failed", backfillError: error, updatedAt: now }).where(expected).returning({ id: mailboxPromotionSettings.mailboxId });
		if (failed.length === 1) console.error(`Promotions backfill failed for mailbox ${candidate.mailboxId}: ${error}`);
		return null;
	}
	const claimed = await db.update(mailboxPromotionSettings)
		.set({ backfillStatus: "running", backfillStalls: candidate.backfillStalls + 1, updatedAt: now })
		.where(expected)
		.returning({ id: mailboxPromotionSettings.mailboxId });
	if (claimed.length !== 1) return null;
	return { mailboxId: candidate.mailboxId, cursor: parseCursor(candidate.backfillCursor), scanned: candidate.backfillScanned, claimedAt: now, dayRows: candidate.backfillDay === today ? candidate.backfillDayRows : 0 };
}

/** What is left of today's installation-wide allowance. A database before the migration has nothing to count, and nothing to backfill. */
async function remainingToday(db: Db, now: Date): Promise<number> {
	try {
		const [row] = await db.select({ rows: sum(mailboxPromotionSettings.backfillDayRows) }).from(mailboxPromotionSettings).where(eq(mailboxPromotionSettings.backfillDay, backfillDay(now)));
		return Math.max(0, BACKFILL_DAILY_CAP - Number(row?.rows ?? 0));
	} catch (error) {
		if (isMissingTableError(error) || isMissingColumnError(error)) return 0;
		throw error;
	}
}

/** The next page of rows to classify: only unclassified (`category IS NULL`, so a manual `primary` is never touched), newest first, after the cursor. */
export async function selectBackfillCandidates(db: Db, input: { mailboxId: string; cursor: BackfillCursor | null; now: Date; limit?: number }) {
	const after = input.cursor === null ? undefined : or(
		lt(messages.createdAt, new Date(input.cursor.createdAt)),
		and(eq(messages.createdAt, new Date(input.cursor.createdAt)), lt(messages.id, input.cursor.id)),
	);
	return db.select({ id: messages.id, rawR2Key: messages.rawR2Key, fromAddr: messages.fromAddr, userId: messages.userId, createdAt: messages.createdAt })
		.from(messages)
		.where(and(
			eq(messages.mailboxId, input.mailboxId),
			eq(messages.direction, "inbound"),
			eq(messages.hasUnsubscribe, true),
			isNull(messages.category),
			isNotNull(messages.rawR2Key),
			gte(messages.createdAt, backfillCutoff(input.now)),
			after,
		))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(input.limit ?? BACKFILL_BATCH);
}

type Candidate = Awaited<ReturnType<typeof selectBackfillCandidates>>[number];

/** Overrides and correspondents of the whole batch in two queries: at most 25 addresses plus one id is 26 binds, under D1's 100. */
async function loadDecisionContext(db: Db, mailboxId: string, rows: Candidate[]) {
	const addresses = [...new Set(rows.map((row) => toSenderAddress(row.fromAddr)).filter((address): address is string => !!address))];
	const overrides = new Map<string, "inbox" | "promotions">();
	const correspondents = new Set<string>();
	if (addresses.length === 0) return { overrides, correspondents };
	try {
		const found = await db.select({ address: mailboxSenderPreferences.senderAddress, override: mailboxSenderPreferences.categoryOverride }).from(mailboxSenderPreferences)
			.where(and(eq(mailboxSenderPreferences.mailboxId, mailboxId), inArray(mailboxSenderPreferences.senderAddress, addresses)));
		for (const row of found) if (row.override) overrides.set(row.address, row.override);
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
	}
	const known = await db.select({ email: contacts.email, source: contacts.source }).from(contacts)
		.where(and(eq(contacts.userId, rows[0].userId), inArray(contacts.email, addresses)));
	for (const contact of known) if (contact.source === "manual" || contact.source === "outbound") correspondents.add(contact.email);
	return { overrides, correspondents };
}

/**
 * Classifies one chunk from the head of each raw message, the same way intake does (`readHeaderMap`, `detectBulkMail`,
 * `decideCategory`). A missing object or an unparseable one is skipped. A bucket error is not: it ends the run,
 * and the stale-takeover logic retries it.
 */
async function promotionIds(env: CloudflareEnv, rows: Candidate[], context: Awaited<ReturnType<typeof loadDecisionContext>>) {
	const promotions: Array<{ id: string; senderAddress: string | null }> = [];
	for (const row of rows) {
		const object = await env.BUCKET.get(row.rawR2Key!, { range: { offset: 0, length: BACKFILL_HEAD_BYTES } });
		if (!object) continue;
		try {
			const senderAddress = toSenderAddress(row.fromAddr);
			const category = decideCategory({
				verdict: detectBulkMail(readHeaderMap(await object.arrayBuffer())),
				override: senderAddress ? context.overrides.get(senderAddress) ?? null : null,
				correspondent: senderAddress ? context.correspondents.has(senderAddress) : false,
			});
			if (category === "promotions") promotions.push({ id: row.id, senderAddress });
		} catch (error) {
			console.error(`Promotions backfill skipped message ${row.id}`, error);
		}
	}
	return promotions;
}

/**
 * Background job: classifies the last 90 days of one mailbox that turned Promotions on, 25 messages per run (and at most
 * 2,000 a day across the installation, counted in `backfill_day_rows`), in chunks of 10 with the cursor saved after each chunk. Writes only promotions (category and sender_address). Every save is fenced on
 * `running`, the mode not being off and the claim's `updated_at`, so a mailbox switched off mid-run, or a run taken over
 * by a newer one, stops without writing. A thrown error leaves the row `running` for the 15-minute takeover.
 */
export async function runPromotionsBackfill(env: CloudflareEnv, now: Date = new Date()): Promise<BackfillResult> {
	const db = getDb(env);
	const allowance = Math.min(BACKFILL_BATCH, await remainingToday(db, now));
	// Out of allowance: the job stays pending and is claimed again after midnight UTC.
	if (allowance === 0) return NOT_CLAIMED;
	const claim = await claimBackfill(db, now);
	if (!claim) return NOT_CLAIMED;
	const owned = and(
		eq(mailboxPromotionSettings.mailboxId, claim.mailboxId),
		eq(mailboxPromotionSettings.backfillStatus, "running"),
		ne(mailboxPromotionSettings.mode, "off"),
		eq(mailboxPromotionSettings.updatedAt, claim.claimedAt),
	);
	const stillOwned = async () => (await db.select({ id: mailboxPromotionSettings.mailboxId }).from(mailboxPromotionSettings).where(owned)).length === 1;
	/** Saves progress; false when the fence no longer holds. */
	const save = async (patch: Partial<typeof mailboxPromotionSettings.$inferInsert>) =>
		(await db.update(mailboxPromotionSettings).set({ backfillStalls: 0, ...patch }).where(owned).returning({ id: mailboxPromotionSettings.mailboxId })).length === 1;

	const page = await selectBackfillCandidates(db, { mailboxId: claim.mailboxId, cursor: claim.cursor, now, limit: allowance });
	const context = await loadDecisionContext(db, claim.mailboxId, page);
	// A page short of the allowance is the end of the mailbox; one that filled it (even a cap-trimmed one) may have more behind it.
	const finalStatus = page.length < allowance ? "done" : "pending";
	let scanned = claim.scanned;
	let promoted = 0;
	if (page.length === 0) {
		await save({ backfillStatus: "done", backfillCursor: null });
		return { claimed: true, scanned: 0, promoted: 0 };
	}
	const chunks = chunk(page, BACKFILL_CHUNK);
	for (const [index, rows] of chunks.entries()) {
		const promotions = await promotionIds(env, rows, context);
		if (!(await stillOwned())) return { claimed: true, scanned: scanned - claim.scanned, promoted };
		if (promotions.length > 0) {
			// The category guard keeps a message the user moved to Inbox meanwhile.
			await db.batch(promotions.map((item) => db.update(messages).set({ category: "promotions", senderAddress: item.senderAddress })
				.where(and(eq(messages.id, item.id), isNull(messages.category)))) as never);
		}
		const last = rows[rows.length - 1];
		scanned += rows.length;
		const lastChunk = index === chunks.length - 1;
		const saved = await save({
			backfillCursor: serializeCursor({ createdAt: last.createdAt.getTime(), id: last.id }),
			backfillScanned: scanned,
			backfillDay: backfillDay(now),
			backfillDayRows: claim.dayRows + (scanned - claim.scanned),
			...(lastChunk ? { backfillStatus: finalStatus } : {}),
		});
		if (!saved) return { claimed: true, scanned: scanned - claim.scanned, promoted };
		promoted += promotions.length;
	}
	return { claimed: true, scanned: scanned - claim.scanned, promoted };
}

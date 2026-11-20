import { and, count, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import type { getDb } from "@/db";
import { mailboxSenderPreferences, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { chunk, MAX_REFILE_ROWS, REFILE_CHUNK_SIZE, refileCutoff, type RefileTarget } from "@/lib/promotions/refile-utils";

type Db = ReturnType<typeof getDb>;

/** Rows of one sender that a move to `target` would still change. Only unfiled received mail: Trash, Spam, Sent and filed mail keep their category. */
function stillToMove(mailboxId: string, senderAddress: string, target: RefileTarget) {
	return and(
		eq(messages.mailboxId, mailboxId),
		eq(messages.senderAddress, senderAddress),
		eq(messages.direction, "inbound"),
		eq(messages.status, "received"),
		isNull(messages.folderId),
		// `primary` counts as Inbox, so moving to Promotions changes null and primary rows, and moving to Inbox changes only promotions.
		target === "promotions" ? or(isNull(messages.category), ne(messages.category, "promotions")) : eq(messages.category, "promotions"),
	)!;
}

/**
 * Re-files one sender's mail, bounded: the newest MAX_REFILE_ROWS rows of the last REFILE_WINDOW_DAYS days,
 * selected by id and written in chunks under D1's parameter limit. Never an unbounded UPDATE.
 * `remainingOlder` counts that sender's rows still outside the target (older than the window or beyond the cap).
 * Rows with a null sender_address are not matched: legacy rows are only reachable through the single-message move.
 */
export async function refileSenderMessages(db: Db, input: { mailboxId: string; senderAddress: string; target: RefileTarget; now?: Date }): Promise<{ changed: number; remainingOlder: number }> {
	const { mailboxId, senderAddress, target } = input;
	const candidates = await db.select({ id: messages.id }).from(messages)
		.where(and(stillToMove(mailboxId, senderAddress, target), gte(messages.createdAt, refileCutoff(input.now ?? new Date()))))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(MAX_REFILE_ROWS);
	let changed = 0;
	for (const ids of chunk(candidates.map((row) => row.id), REFILE_CHUNK_SIZE)) {
		// The guard repeats the category test so a row moved meanwhile is neither rewritten nor counted.
		const updated = await db.update(messages).set({ category: target })
			.where(and(inArray(messages.id, ids), eq(messages.mailboxId, mailboxId), stillToMove(mailboxId, senderAddress, target)))
			.returning({ id: messages.id });
		changed += updated.length;
	}
	const [{ remaining }] = await db.select({ remaining: count() }).from(messages).where(stillToMove(mailboxId, senderAddress, target));
	return { changed, remainingOlder: Number(remaining) };
}

/** Stores (or with null clears) the sender's override. Clearing never moves mail. */
export async function setSenderOverride(db: Db, input: { mailboxId: string; senderAddress: string; override: "inbox" | "promotions" | null; userId: string }): Promise<void> {
	const values = { categoryOverride: input.override, updatedByUserId: input.userId, updatedAt: new Date() };
	if (input.override === null) {
		await db.update(mailboxSenderPreferences).set(values)
			.where(and(eq(mailboxSenderPreferences.mailboxId, input.mailboxId), eq(mailboxSenderPreferences.senderAddress, input.senderAddress)));
		return;
	}
	await db.insert(mailboxSenderPreferences)
		.values({ id: newId("msp"), mailboxId: input.mailboxId, senderAddress: input.senderAddress, ...values })
		.onConflictDoUpdate({ target: [mailboxSenderPreferences.mailboxId, mailboxSenderPreferences.senderAddress], set: values });
}

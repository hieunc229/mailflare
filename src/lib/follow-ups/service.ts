import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { followUps, messages } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { updateInBatches } from "@/lib/db-params";
import { newId } from "@/lib/ids";
import { followUpDueAt } from "./follow-up-utils";
import type { DueFollowUp, MessageFollowUp } from "./types";

/** Rows processed per cron run; the next run picks up the rest. */
const REMINDER_BATCH = 200;
const MAX_LISTED = 50;

/** An inbound message joined the sent message's thread after it was sent. Mirrors `isReplyTo`. */
const hasReply = sql<number>`exists (
	select 1 from messages reply
	where reply.thread_id = ${messages.threadId}
		and reply.mailbox_id = ${messages.mailboxId}
		and reply.direction = 'inbound'
		and reply.created_at > ${messages.createdAt}
)`;

async function markReplied(env: CloudflareEnv, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const db = getDb(env);
	await updateInBatches(ids, (batch) => db.update(followUps).set({ status: "replied" }).where(inArray(followUps.id, batch)));
}

/** Arms (or re-arms) the reminder on a sent message. */
export async function setFollowUp(env: CloudflareEnv, input: { messageId: string; userId: string; days: number; from?: Date }): Promise<MessageFollowUp> {
	const dueAt = followUpDueAt(input.from ?? new Date(), input.days);
	const [row] = await getDb(env)
		.insert(followUps)
		.values({ id: newId("fup"), messageId: input.messageId, userId: input.userId, dueAt })
		.onConflictDoUpdate({ target: followUps.messageId, set: { dueAt, status: "pending", userId: input.userId } })
		.returning({ id: followUps.id, status: followUps.status, dueAt: followUps.dueAt });
	return { id: row.id, status: row.status, dueAt: row.dueAt.toISOString() };
}

/** Five-minute cron: due reminders without a reply surface, the rest are closed as replied. */
export async function runFollowUpReminders(env: CloudflareEnv, now: Date): Promise<void> {
	try {
		const db = getDb(env);
		const rows = await db
			.select({ id: followUps.id, replied: hasReply })
			.from(followUps)
			.innerJoin(messages, eq(messages.id, followUps.messageId))
			.where(and(eq(followUps.status, "pending"), lte(followUps.dueAt, now)))
			.limit(REMINDER_BATCH);
		await markReplied(env, rows.filter((row) => row.replied).map((row) => row.id));
		const due = rows.filter((row) => !row.replied).map((row) => row.id);
		if (due.length) await updateInBatches(due, (batch) => db.update(followUps).set({ status: "due" }).where(inArray(followUps.id, batch)));
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
	}
}

/** The user's reminders that came due without a reply, newest first. A reply that arrived since closes them. */
export async function listDueFollowUps(env: CloudflareEnv, userId: string, mailboxId?: string | null): Promise<DueFollowUp[]> {
	try {
		const rows = await getDb(env)
			.select({
				id: followUps.id,
				messageId: followUps.messageId,
				dueAt: followUps.dueAt,
				mailboxId: messages.mailboxId,
				subject: messages.subject,
				toAddr: messages.toAddr,
				sentAt: messages.createdAt,
				replied: hasReply,
			})
			.from(followUps)
			.innerJoin(messages, eq(messages.id, followUps.messageId))
			.where(and(
				eq(followUps.userId, userId),
				eq(followUps.status, "due"),
				...(mailboxId ? [eq(messages.mailboxId, mailboxId)] : []),
			))
			.orderBy(desc(followUps.dueAt))
			.limit(MAX_LISTED);
		await markReplied(env, rows.filter((row) => row.replied).map((row) => row.id));
		return rows.filter((row) => !row.replied).map((row) => ({
			id: row.id,
			messageId: row.messageId,
			mailboxId: row.mailboxId,
			subject: row.subject,
			toAddr: row.toAddr,
			sentAt: row.sentAt.toISOString(),
			dueAt: row.dueAt.toISOString(),
		}));
	} catch (error) {
		if (isMissingTableError(error)) return [];
		throw error;
	}
}

export async function getMessageFollowUp(env: CloudflareEnv, userId: string, messageId: string): Promise<MessageFollowUp | null> {
	try {
		const [row] = await getDb(env)
			.select({ id: followUps.id, status: followUps.status, dueAt: followUps.dueAt, replied: hasReply })
			.from(followUps)
			.innerJoin(messages, eq(messages.id, followUps.messageId))
			.where(and(eq(followUps.messageId, messageId), eq(followUps.userId, userId)))
			.limit(1);
		if (!row) return null;
		const open = row.status === "pending" || row.status === "due";
		if (open && row.replied) await markReplied(env, [row.id]);
		return { id: row.id, status: open && row.replied ? "replied" : row.status, dueAt: row.dueAt.toISOString() };
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

/** Dismisses the user's reminder, or pushes it back by `snoozeDays`. Returns false when it is not theirs. */
export async function updateFollowUp(
	env: CloudflareEnv,
	userId: string,
	id: string,
	change: { action: "dismiss" } | { action: "snooze"; days: number },
): Promise<boolean> {
	const set = change.action === "dismiss"
		? { status: "dismissed" as const }
		: { status: "pending" as const, dueAt: followUpDueAt(new Date(), change.days) };
	const updated = await getDb(env)
		.update(followUps)
		.set(set)
		.where(and(eq(followUps.id, id), eq(followUps.userId, userId)))
		.returning({ id: followUps.id });
	return updated.length > 0;
}

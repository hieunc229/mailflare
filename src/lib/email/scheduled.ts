import { and, eq, exists, isNotNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs } from "@/db/schema";

/** Matches outbound messages whose send job is still waiting for its scheduled time. */
export function scheduledMessageCondition(db: ReturnType<typeof getDb>): SQL {
	return and(
		eq(messages.direction, "outbound"),
		eq(messages.status, "queued"),
		exists(
			db
				.select({ id: outboundJobs.id })
				.from(outboundJobs)
				.where(and(eq(outboundJobs.messageId, messages.id), eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt))),
		),
	)!;
}

/** When a queued outbound message is scheduled to go out; null when it is not scheduled. */
export async function getScheduledTime(db: ReturnType<typeof getDb>, messageId: string): Promise<Date | null> {
	const [job] = await db
		.select({ scheduledAt: outboundJobs.scheduledAt })
		.from(outboundJobs)
		.where(and(eq(outboundJobs.messageId, messageId), eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt)))
		.limit(1);
	return job?.scheduledAt ?? null;
}

/** Cancels a scheduled send and returns the message to Drafts. Deletes only a job that is
 * still waiting: the queue consumer claims it (queued -> sending) before delivering, so a
 * send already under way is left alone. Returns false when there was nothing to cancel. */
export async function cancelScheduledSend(db: ReturnType<typeof getDb>, messageId: string): Promise<boolean> {
	const deleted = await db
		.delete(outboundJobs)
		.where(and(eq(outboundJobs.messageId, messageId), eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt)))
		.returning({ id: outboundJobs.id });
	if (!deleted.length) return false;
	await db.update(messages).set({ status: "draft" }).where(and(eq(messages.id, messageId), eq(messages.status, "queued")));
	return true;
}

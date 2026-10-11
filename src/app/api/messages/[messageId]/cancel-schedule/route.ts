import { and, eq, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages, outboundJobs } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

/**
 * Cancels a scheduled send and returns the message to Drafts. Deleting the job is
 * what stops delivery: the queue consumer skips messages whose job is gone.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, direction: messages.direction, status: messages.status })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	if (!access.canSendAs && !access.canSendOnBehalf) {
		return NextResponse.json({ error: "You cannot cancel sends from this mailbox" }, { status: 403 });
	}

	const [job] = await db
		.select({ id: outboundJobs.id })
		.from(outboundJobs)
		.where(and(
			eq(outboundJobs.messageId, message.id),
			eq(outboundJobs.status, "queued"),
			isNotNull(outboundJobs.scheduledAt),
		))
		.limit(1);
	if (message.direction !== "outbound" || message.status !== "queued" || !job) {
		return NextResponse.json({ error: "This message is not scheduled" }, { status: 409 });
	}

	// Only a job that is still waiting can be cancelled; the queue consumer claims it
	// (queued -> sending) before delivering, so a send already under way is left alone.
	const deleted = await db
		.delete(outboundJobs)
		.where(and(eq(outboundJobs.id, job.id), eq(outboundJobs.status, "queued")))
		.returning({ id: outboundJobs.id });
	if (!deleted.length) {
		return NextResponse.json({ error: "This message is already being sent" }, { status: 409 });
	}
	await db.update(messages).set({ status: "draft" }).where(and(eq(messages.id, message.id), eq(messages.status, "queued")));
	return NextResponse.json({ ok: true });
}

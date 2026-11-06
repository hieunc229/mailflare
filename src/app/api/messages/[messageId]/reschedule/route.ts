import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getScheduledTime, rescheduleScheduledSend } from "@/lib/email/scheduled";
import { enqueueOutboundJob } from "@/lib/email/send";
import type { RescheduleMessagePayload } from "./types";
import { getRescheduledAt } from "./utils";

/**
 * Moves a scheduled send to a new time. The job row is what the queue consumer
 * checks, so a queue message still holding the old time re-queues instead of
 * sending early; the fresh enqueue is what makes an earlier time take effect.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const payload = (await request.json().catch(() => null)) as RescheduleMessagePayload | null;
	const scheduledAt = getRescheduledAt(payload?.scheduledAt);
	if (!scheduledAt) {
		return NextResponse.json({ error: "Choose a future send time" }, { status: 400 });
	}

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
		return NextResponse.json({ error: "You cannot schedule sends from this mailbox" }, { status: 403 });
	}

	if (message.direction !== "outbound" || message.status !== "queued" || !(await getScheduledTime(db, message.id))) {
		return NextResponse.json({ error: "This message is not scheduled" }, { status: 409 });
	}
	const jobId = await rescheduleScheduledSend(db, message.id, scheduledAt);
	if (!jobId) {
		return NextResponse.json({ error: "This message is already being sent" }, { status: 409 });
	}
	await enqueueOutboundJob(env, jobId, message.id, scheduledAt);
	return NextResponse.json({ ok: true, scheduledAt: scheduledAt.toISOString() });
}

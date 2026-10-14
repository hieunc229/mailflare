import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { cancelScheduledSend, getScheduledTime } from "@/lib/email/scheduled";

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

	if (message.direction !== "outbound" || message.status !== "queued" || !(await getScheduledTime(db, message.id))) {
		return NextResponse.json({ error: "This message is not scheduled" }, { status: 409 });
	}
	if (!(await cancelScheduledSend(db, message.id))) {
		return NextResponse.json({ error: "This message is already being sent" }, { status: 409 });
	}
	return NextResponse.json({ ok: true });
}

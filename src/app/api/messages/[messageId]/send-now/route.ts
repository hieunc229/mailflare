import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { sendScheduledMessageNow } from "@/lib/email/send";

/**
 * Sends a queued message now instead of waiting for its undo window or scheduled time.
 * The job is claimed before delivery, so the queued send cannot also deliver it.
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
		return NextResponse.json({ error: "You cannot send from this mailbox" }, { status: 403 });
	}

	if (message.direction !== "outbound" || message.status !== "queued") {
		return NextResponse.json({ error: "This message is already on its way" }, { status: 409 });
	}
	try {
		if (!(await sendScheduledMessageNow(env, message.id))) {
			return NextResponse.json({ error: "This message is already on its way" }, { status: 409 });
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : "Send failed";
		return NextResponse.json({ error: detail }, { status: 500 });
	}
	return NextResponse.json({ ok: true });
}

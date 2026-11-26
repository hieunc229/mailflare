import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isOthersDraft } from "@/lib/email/draft-access";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

export async function POST(
	_request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, _request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, userId: messages.userId, mailboxId: messages.mailboxId, status: messages.status, privateDraft: messages.privateDraft, starred: messages.starred })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isOthersDraft(message, user.id)) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	// The flag is stored on the shared message, so it needs the same floor as JMAP: any permission above read-only.
	if (!access.canSendOnBehalf) return NextResponse.json({ error: "You cannot change messages in this mailbox" }, { status: 403 });

	const starred = !message.starred;
	await db.update(messages).set({ starred }).where(eq(messages.id, message.id));
	return NextResponse.json({ starred });
}

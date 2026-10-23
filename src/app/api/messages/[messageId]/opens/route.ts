import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getMessageTrackingSummary } from "@/lib/tracking/open-tracking";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, direction: messages.direction })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	if (message.direction !== "outbound") return NextResponse.json({ tracking: null });

	try {
		return NextResponse.json({ tracking: await getMessageTrackingSummary(env, messageId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ tracking: null });
		throw error;
	}
}

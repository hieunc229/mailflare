import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
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
		.select({ id: messages.id, mailboxId: messages.mailboxId, starred: messages.starred })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const body = (await _request.json().catch(() => null)) as { starred?: unknown } | null;
	const payload = body && typeof body === "object" ? body : {};
	if (payload.starred !== undefined && typeof payload.starred !== "boolean") {
		return NextResponse.json({ error: "Invalid star state" }, { status: 400 });
	}

	const starred = payload.starred ?? !message.starred;
	await db.update(messages).set({ starred }).where(eq(messages.id, message.id));
	return NextResponse.json({ starred });
}

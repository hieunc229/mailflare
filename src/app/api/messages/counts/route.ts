import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { buildMessageCounts } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const db = getDb(env);
	const conditions = [eq(messages.userId, user.id)];

	if (mailboxId) {
		conditions.push(eq(messages.mailboxId, mailboxId));
	}

	const rows = await db
		.select({
			mailboxId: messages.mailboxId,
			direction: messages.direction,
			status: messages.status,
			read: messages.read,
		})
		.from(messages)
		.where(and(...conditions));

	return NextResponse.json({ counts: buildMessageCounts(rows) });
}

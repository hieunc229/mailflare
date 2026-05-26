import { NextResponse } from "next/server";
import { eq, desc, and } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getDb } from "@/db";
import { messages } from "@/db/schema";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const direction = url.searchParams.get("direction");
	const mailboxId = url.searchParams.get("mailboxId");
	const status = url.searchParams.get("status");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);

	const db = getDb(env);
	const conditions = [eq(messages.userId, user.id)];
	if (direction === "inbound" || direction === "outbound") {
		conditions.push(eq(messages.direction, direction));
	}
	if (mailboxId) {
		conditions.push(eq(messages.mailboxId, mailboxId));
	}
	if (status) {
		conditions.push(eq(messages.status, status));
	}

	const rows = await db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt))
		.limit(limit);

	return NextResponse.json({ messages: rows });
}

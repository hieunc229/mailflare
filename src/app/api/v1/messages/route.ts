import { NextResponse } from "next/server";
import { eq, desc, and } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { getDb } from "@/db";
import { messages } from "@/db/schema";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "read")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const direction = url.searchParams.get("direction");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);

	const db = getDb(env);
	const conditions = [eq(messages.userId, auth.userId)];
	if (mailboxId) conditions.push(eq(messages.mailboxId, mailboxId));
	if (direction === "inbound" || direction === "outbound") {
		conditions.push(eq(messages.direction, direction));
	}

	const rows = await db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt))
		.limit(limit);

	return NextResponse.json({ messages: rows });
}

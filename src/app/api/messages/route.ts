import { NextResponse } from "next/server";
import { eq, desc, and, like, or, count } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { normalizeEmailAddress } from "@/lib/email/address";
import { getLatestEmailContent } from "@/lib/email/reply-content-utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const direction = url.searchParams.get("direction");
	const mailboxId = url.searchParams.get("mailboxId");
	const status = url.searchParams.get("status");
	const query = url.searchParams.get("q")?.trim();
	const title = url.searchParams.get("title")?.trim();
	const read = url.searchParams.get("read");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
	const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

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
	if (read === "read") {
		conditions.push(eq(messages.read, true));
	}
	if (read === "unread") {
		conditions.push(eq(messages.read, false));
	}
	if (query) {
		const pattern = `%${query}%`;
		const queryCondition = or(
			like(messages.fromAddr, pattern),
			like(messages.toAddr, pattern),
			like(messages.subject, pattern),
			like(messages.snippet, pattern),
		);
		if (queryCondition) conditions.push(queryCondition);
	}
	if (title) {
		conditions.push(like(messages.subject, `%${title}%`));
	}
	const where = and(...conditions);

	const [totalRow] = await db
		.select({ total: count() })
		.from(messages)
		.where(where);
	const rows = await db
		.select()
		.from(messages)
		.where(where)
		.orderBy(desc(messages.createdAt))
		.limit(limit)
		.offset(offset);
	const contactMap = await getContactDisplayNameMap(
		env,
		user.id,
		rows.flatMap((message) => [message.fromAddr, message.toAddr]),
	);
	const enrichedRows = rows.map((message) => ({
		...message,
		snippet: getLatestEmailContent(message.snippet),
		fromContactName: contactMap.get(normalizeEmailAddress(message.fromAddr)) ?? null,
		toContactName: contactMap.get(normalizeEmailAddress(message.toAddr)) ?? null,
	}));

	return NextResponse.json({ messages: enrichedRows, total: totalRow?.total ?? 0, limit, offset });
}

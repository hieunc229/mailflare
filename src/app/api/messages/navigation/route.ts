import { NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { scheduledMessageCondition } from "@/lib/email/scheduled";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import type { MessageFolder } from "@/hooks/types";
import type { MessageNavigationEntry } from "./types";

const folders: MessageFolder[] = ["inbox", "starred", "snoozed", "sent", "scheduled", "archived", "spam", "trash"];

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const params = new URL(request.url).searchParams;
	const folder = params.get("folder") as MessageFolder | null;
	if (!folder || !folders.includes(folder)) {
		return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
	}

	const mailboxId = params.get("mailboxId");
	const folderId = params.get("folderId");
	const grouped = params.get("group") === "thread";
	const db = getDb(env);
	const conditions: SQL[] = [];
	if (mailboxId) {
		const access = await getMailboxAccessLevel(db, user, mailboxId);
		if (!access?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		conditions.push(eq(messages.mailboxId, mailboxId));
	} else {
		const accessibleIds = await listAccessibleMailboxIds(db, user);
		conditions.push(accessibleIds.length > 0
			? inArray(messages.mailboxId, accessibleIds)
			: eq(messages.userId, user.id));
	}

	if (folder === "inbox") {
		conditions.push(eq(messages.direction, "inbound"));
		conditions.push(eq(messages.status, "received"));
		if (!folderId) {
			conditions.push(isNull(messages.folderId));
			conditions.push(or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!);
		}
	} else if (folder === "starred") {
		conditions.push(eq(messages.starred, true));
	} else if (folder === "snoozed") {
		conditions.push(eq(messages.status, "received"));
		conditions.push(isNull(messages.folderId));
		conditions.push(gt(messages.snoozedUntil, new Date()));
	} else if (folder === "sent") {
		conditions.push(eq(messages.direction, "outbound"));
		conditions.push(eq(messages.status, "sent"));
	} else if (folder === "scheduled") {
		conditions.push(scheduledMessageCondition(db));
	} else {
		conditions.push(eq(messages.status, folder));
	}
	if (folderId) conditions.push(eq(messages.folderId, folderId));

	const rows = await db.select({
		id: messages.id,
		read: messages.read,
		direction: messages.direction,
		threadId: messages.threadId,
	}).from(messages).where(and(...conditions)).orderBy(desc(messages.createdAt), desc(messages.id));

	const entries: MessageNavigationEntry[] = [];
	if (grouped) {
		const byThread = new Map<string, MessageNavigationEntry>();
		for (const row of rows) {
			const key = row.threadId ?? row.id;
			const unread = row.direction === "inbound" && !row.read;
			const existing = byThread.get(key);
			if (existing) existing.unread ||= unread;
			else byThread.set(key, { id: row.id, unread });
		}
		// push(...spread) passes each entry as an argument and RangeErrors on
		// large folders (~100k+ messages); append in a loop instead.
		for (const entry of byThread.values()) entries.push(entry);
	} else {
		for (const row of rows) {
			entries.push({ id: row.id, unread: row.direction === "inbound" && !row.read });
		}
	}

	return NextResponse.json({ messages: entries });
}

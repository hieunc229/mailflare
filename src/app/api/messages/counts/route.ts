import { and, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { scheduledMessageCondition } from "@/lib/email/scheduled";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import { activePromotionModes, applyPromotionCounts, buildMessageCounts } from "./utils";
import { loadPromotionModes } from "@/lib/promotions/settings";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const db = getDb(env);
	const conditions: SQL[] = [];
	let mailboxIds: string[] = [];

	if (mailboxId) {
		const access = await getMailboxAccessLevel(db, user, mailboxId);
		if (!access?.canRead) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		conditions.push(eq(messages.mailboxId, mailboxId));
		mailboxIds = [mailboxId];
	} else {
		const accessibleMailboxIds = await listAccessibleMailboxIds(db, user);
		mailboxIds = accessibleMailboxIds;
		if (accessibleMailboxIds.length > 0) {
			conditions.push(inArray(messages.mailboxId, accessibleMailboxIds));
		} else {
			conditions.push(eq(messages.userId, user.id));
		}
	}

	conditions.push(draftsVisibleTo(user.id));

	const rows = await db
		.select({
			mailboxId: messages.mailboxId,
			folderId: messages.folderId,
			direction: messages.direction,
			status: messages.status,
			read: messages.read,
			starred: messages.starred,
			snoozedUntil: messages.snoozedUntil,
			total: count(),
			scheduledTotal: sql<number>`sum(case when ${scheduledMessageCondition(db)} then 1 else 0 end)`,
		})
		.from(messages)
		.where(and(...conditions))
		.groupBy(
			messages.mailboxId,
			messages.folderId,
			messages.direction,
			messages.status,
			messages.read,
			messages.starred,
			messages.snoozedUntil,
		);

	const counts = buildMessageCounts(rows);
	counts.folders.scheduled.total = rows.reduce((total, row) => total + (Number(row.scheduledTotal) || 0), 0);

	// Promotions get their own query, and only for mailboxes that opted in, so the grouped query above is unchanged.
	const modes = await loadPromotionModes(db, mailboxIds);
	counts.promotionModes = activePromotionModes(modes);
	const activeIds = Object.keys(counts.promotionModes);
	if (activeIds.length > 0) {
		const promotionRows = await db
			.select({ mailboxId: messages.mailboxId, read: messages.read, total: count() })
			.from(messages)
			.where(and(
				inArray(messages.mailboxId, activeIds),
				eq(messages.direction, "inbound"),
				eq(messages.status, "received"),
				isNull(messages.folderId),
				eq(messages.category, "promotions"),
				or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date())),
			))
			.groupBy(messages.mailboxId, messages.read);
		applyPromotionCounts(counts, promotionRows, new Set(activeIds.filter((id) => modes.get(id) === "separate")));
	}

	return NextResponse.json({ counts });
}

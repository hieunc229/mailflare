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
import { canReadMailbox, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { parseMailboxIdList } from "@/lib/api/query-params";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	// `mailboxIds` counts a subset of the accessible mailboxes; the breakdown below
	// then reports only that subset.
	const mailboxIdList = parseMailboxIdList(url.searchParams.get("mailboxIds"));
	if (mailboxIdList.error) {
		return NextResponse.json({ error: mailboxIdList.error }, { status: 400 });
	}
	if (mailboxId && mailboxIdList.ids) {
		return NextResponse.json({ error: "mailboxId and mailboxIds are mutually exclusive" }, { status: 400 });
	}
	const db = getDb(env);
	const conditions: SQL[] = [];
	let mailboxIds: string[] = [];

	if (mailboxId) {
		if (!(await canReadMailbox(db, user, mailboxId))) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		conditions.push(eq(messages.mailboxId, mailboxId));
		mailboxIds = [mailboxId];
	} else if (mailboxIdList.ids) {
		// Unknown and forbidden ids share the single-mailbox 404 so the response never
		// reveals which ids exist.
		for (const id of mailboxIdList.ids) {
			if (!(await canReadMailbox(db, user, id))) {
				return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
			}
		}
		conditions.push(inArray(messages.mailboxId, mailboxIdList.ids));
		mailboxIds = mailboxIdList.ids;
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

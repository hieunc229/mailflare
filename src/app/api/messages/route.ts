import { NextResponse } from "next/server";
import { eq, desc, and, or, count, isNull, isNotNull, inArray, lte, gt, notInArray, ne, sql, sum } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getDb } from "@/db";
import { messages, outboundJobs } from "@/db/schema";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { getSenderDisplayName } from "@/lib/contacts/utils";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import { getMailboxAccessLevel, hasMailboxPermission, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import { buildSearchConditions } from "@/lib/search/conditions";
import { getRequestTimeZone } from "@/lib/time/utils";
import { scheduledMessageCondition } from "@/lib/email/scheduled";
import { getMessageListColumns, loadConversationPage } from "./utils";
import type { ListMessage } from "./types";
import { getOpenCounts } from "@/lib/tracking/open-tracking";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const direction = url.searchParams.get("direction");
	const mailboxId = url.searchParams.get("mailboxId");
	const folderId = url.searchParams.get("folderId");
	const status = url.searchParams.get("status");
	const query = url.searchParams.get("q")?.trim();
	const title = url.searchParams.get("title")?.trim();
	const read = url.searchParams.get("read");
	const starred = url.searchParams.get("starred");
	const snoozed = url.searchParams.get("snoozed");
	const scheduled = url.searchParams.get("scheduled");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
	const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
	// Conversation view: one row per thread, represented by its newest message
	// that matches the filter. Drafts are never grouped.
	const groupByThread = url.searchParams.get("group") === "thread" && status !== "draft";

	const db = getDb(env);
	const accessibleMailboxes = await listAccessibleMailboxes(db, user);
	const accessibleMailboxIds = accessibleMailboxes.map((mailbox) => mailbox.id);
	const conditions: SQL[] = [];
	if (mailboxId) {
		const mailbox = accessibleMailboxes.find((mailbox) => mailbox.id === mailboxId);
		// Reuse this request's authorization; retain the fallback for mailboxes
		// omitted by the list's domain join (for example, legacy orphaned rows).
		const canRead = mailbox
			? hasMailboxPermission(mailbox.permission, "read_only")
			: (await getMailboxAccessLevel(db, user, mailboxId))?.canRead;
		if (!canRead) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		conditions.push(eq(messages.mailboxId, mailboxId));
	} else if (accessibleMailboxIds.length > 0) {
		conditions.push(inArray(messages.mailboxId, accessibleMailboxIds));
	} else {
		conditions.push(eq(messages.userId, user.id));
	}
	if (direction === "inbound" || direction === "outbound") {
		conditions.push(eq(messages.direction, direction));
	}
	if (folderId) {
		conditions.push(eq(messages.folderId, folderId));
	}
	if (status) {
		conditions.push(eq(messages.status, status));
	}
	// Composer templates are stored as messages but never listed.
	if (status !== "template") {
		conditions.push(ne(messages.status, "template"));
	}
	if (status === "received" && !folderId) {
		conditions.push(isNull(messages.folderId));
		conditions.push(or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!);
	}
	if (starred === "true") {
		conditions.push(eq(messages.starred, true));
	}
	if (snoozed === "true") {
		conditions.push(eq(messages.status, "received"));
		conditions.push(isNull(messages.folderId));
		conditions.push(gt(messages.snoozedUntil, new Date()));
	}
	if (scheduled === "true") {
		conditions.push(scheduledMessageCondition(db));
	}
	if (read === "read") {
		conditions.push(eq(messages.read, true));
	}
	if (read === "unread") {
		conditions.push(eq(messages.read, false));
	}
	if (query || title) {
		// Operators (from:, has:attachment, before:) and free text go through the
		// full-text index; `title` is the legacy subject filter and is folded in.
		conditions.push(...buildSearchConditions(title ? `${query ?? ""} subject:"${title}"` : query ?? "", getRequestTimeZone(request, user.timeZone)));
	}
	const where = and(...conditions);
	// Messages that were never threaded (older rows, drafts) stand alone.
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;

	// The list renders `snippet`. Bodies stay on the thread endpoint.
	const messageListColumns = getMessageListColumns();

	let total = 0;
	let rows: ListMessage[];
	// Which stored messages each visible row stands for, so acting on a
	// conversation row acts on the whole conversation within this folder.
	const threadMessageIds = new Map<string, string[]>();
	// Unread messages per conversation within this folder; the row's unread state
	// has to match what marking it read will actually change.
	const scopedThreadCounts = new Map<string, { total: number; unread: number }>();
	if (groupByThread) {
		const page = await loadConversationPage({ db, where, offset, limit });
		total = page.total;
		rows = page.ids.length
			? await db.select(messageListColumns).from(messages).where(and(where, inArray(messages.id, page.ids)))
			: [];
		const rowById = new Map(rows.map((row) => [row.id, row]));
		rows = page.ids.map((id) => rowById.get(id)).filter((row): row is ListMessage => !!row);
		const keys = rows.map((row) => row.threadId ?? row.id);
		if (keys.length > 0) {
			const members = await db
				.select({ id: messages.id, key: threadKey, read: messages.read })
				.from(messages)
				.where(and(where, inArray(threadKey, keys)));
			for (const member of members) {
				const list = threadMessageIds.get(member.key) ?? [];
				list.push(member.id);
				threadMessageIds.set(member.key, list);
				const counts = scopedThreadCounts.get(member.key) ?? { total: 0, unread: 0 };
				counts.total += 1;
				if (!member.read) counts.unread += 1;
				scopedThreadCounts.set(member.key, counts);
			}
		}
	} else {
		const [totals, pageRows] = await Promise.all([
			db.select({ total: count() }).from(messages).where(where),
			db
				.select(messageListColumns)
				.from(messages)
				.where(where)
				.orderBy(desc(messages.createdAt))
				.limit(limit)
				.offset(offset),
		]);
		total = totals[0]?.total ?? 0;
		rows = pageRows;
	}
	// Conversation sizes for the rows on this page, so the list can show "(3)"
	// next to a subject the way threaded clients do.
	const threadIds = Array.from(new Set(rows.map((row) => row.threadId).filter((id): id is string => !!id)));
	const scope = mailboxId
		? eq(messages.mailboxId, mailboxId)
		: accessibleMailboxIds.length > 0
			? inArray(messages.mailboxId, accessibleMailboxIds)
			: eq(messages.userId, user.id);
	// These enrichments depend only on the selected page, not on each other.
	const [countRows, jobs, openCounts, contactMaps] = await Promise.all([
		threadIds.length > 0
			? db
				.select({
					threadId: messages.threadId,
					total: count(),
					unread: sum(sql`case when ${messages.read} then 0 else 1 end`),
				})
				.from(messages)
				.where(and(scope, inArray(messages.threadId, threadIds), isNotNull(messages.threadId), notInArray(messages.status, ["draft", "trash"])))
				.groupBy(messages.threadId)
			: [],
		scheduled === "true" && rows.length > 0
			? db
				.select({ messageId: outboundJobs.messageId, scheduledAt: outboundJobs.scheduledAt })
				.from(outboundJobs)
				.where(and(inArray(outboundJobs.messageId, rows.map((row) => row.id)), eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt)))
			: [],
		getOpenCounts(env, rows.filter((row) => row.direction === "outbound").map((row) => row.id)),
		Promise.all(
			Array.from(new Set(rows.map((message) => message.userId))).map(async (userId) => [
				userId,
				await getContactDisplayNameMap(
					env,
					userId,
					rows
						.filter((message) => message.userId === userId)
						.flatMap((message) => [message.fromAddr, getFirstEmailAddressEntry(message.toAddr)]),
				),
			] as const),
		),
	]);
	const threadCounts = new Map<string, { total: number; unread: number }>();
	for (const row of countRows) {
		if (row.threadId) threadCounts.set(row.threadId, { total: row.total, unread: Number(row.unread ?? 0) });
	}
	const scheduledAtByMessageId = new Map<string, string>();
	for (const job of jobs) {
		if (job.messageId && job.scheduledAt) scheduledAtByMessageId.set(job.messageId, job.scheduledAt.toISOString());
	}
	const mailboxNameMap = new Map(
		accessibleMailboxes.map((mailbox) => [
			mailbox.id,
			mailbox.userId === user.id && tracksAccountIdentity(mailbox, user.email)
				? user.name
				: mailbox.displayName ?? mailbox.localPart,
		]),
	);
	const contactMapsByUserId = new Map(contactMaps);
	// `Message.textBody`/`htmlBody` are optional on the wire type and the
	// reading pane loads them from /api/messages/[id]/thread, so they are
	// neither selected nor sent here.
	const enrichedRows = rows.map(({ rawR2Key: _rawR2Key, ...message }) => {
		const threadStats = message.threadId ? threadCounts.get(message.threadId) : undefined;
		const folderUnread = scopedThreadCounts.get(message.threadId ?? message.id)?.unread;
		const contactMap = contactMapsByUserId.get(message.userId);
		const accountName = message.mailboxId ? mailboxNameMap.get(message.mailboxId) : null;
		return {
			...message,
			snippet: message.snippet,
			...(scheduledAtByMessageId.has(message.id) ? { scheduledAt: scheduledAtByMessageId.get(message.id) } : {}),
			...(openCounts.has(message.id) ? { openCount: openCounts.get(message.id) } : {}),
			fromContactName:
				(message.direction === "outbound" ? accountName : null) ??
				getSenderDisplayName(message.fromAddr, contactMap?.get(normalizeEmailAddress(message.fromAddr))),
			toContactName:
				contactMap?.get(normalizeEmailAddress(getFirstEmailAddressEntry(message.toAddr)))?.displayName ?? null,
			threadCount: threadStats?.total || 1,
			threadUnread: (groupByThread ? folderUnread : threadStats?.unread) || 0,
			...(groupByThread
				? { threadMessageIds: threadMessageIds.get(message.threadId ?? message.id) ?? [message.id] }
				: {}),
		};
	});

	return NextResponse.json({ messages: enrichedRows, total, limit, offset, grouped: groupByThread });
}

import { countDistinct, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { messages } from "@/db/schema";
import type { ConversationPage, ConversationPageInput, MessageListColumns } from "./types";

export function getMessageListColumns(): MessageListColumns {
	return Object.fromEntries(
		Object.entries(getTableColumns(messages)).filter(([name]) => name !== "textBody" && name !== "htmlBody"),
	) as MessageListColumns;
}

/** Select one newest matching message per thread before applying pagination. */
export async function loadConversationPage({ db, where, offset, limit }: ConversationPageInput): Promise<ConversationPage> {
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;

	// A conversation sorts by its newest matching message, so the first page of
	// heads is just the first occurrence of each thread key while scanning
	// messages newest-first — an index-ordered walk instead of a window
	// function over the whole result set. Threads are usually a handful of
	// messages, so one or two small batches fill a page.
	const needed = offset + limit;
	// Constant bound: offset is client input, so the scan must never scale
	// with it. Deep pages also can't be satisfied by the scan at all (heads
	// can never outnumber fetched rows), so they take the windowed plan
	// directly.
	const SCAN_CAP = 10_000;
	if (needed > SCAN_CAP) {
		return loadConversationPageWindowed({ db, where, offset, limit });
	}
	const headIds: string[] = [];
	const seen = new Set<string>();
	let fetched = 0;
	let exhausted = false;
	while (headIds.length < needed && !exhausted && fetched < SCAN_CAP) {
		const batch = Math.min(1000, Math.max(200, needed * 4));
		const rows = await db
			.select({ id: messages.id, key: threadKey })
			.from(messages)
			.where(where)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(batch)
			.offset(fetched);
		fetched += rows.length;
		if (rows.length < batch) exhausted = true;
		for (const row of rows) {
			if (seen.has(row.key)) continue;
			seen.add(row.key);
			headIds.push(row.id);
		}
		// Threads averaging more than ~10 messages per head make the scan pay
		// ~10 rows per head — the windowed plan wins on that shape, so bail
		// early rather than discovering it at the cap.
		if (headIds.length < needed && headIds.length * 10 < fetched) {
			return loadConversationPageWindowed({ db, where, offset, limit });
		}
	}
	// Only reachable on degenerate thread shapes; keep the old plan as the
	// correctness net rather than walking the table forever.
	if (!exhausted && headIds.length < needed) {
		return loadConversationPageWindowed({ db, where, offset, limit });
	}
	const [totals] = await db.select({ total: countDistinct(threadKey) }).from(messages).where(where);
	return { ids: headIds.slice(offset, offset + limit), total: totals?.total ?? 0 };
}

async function loadConversationPageWindowed({ db, where, offset, limit }: ConversationPageInput): Promise<ConversationPage> {
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;
	const ranked = db
		.select({
			id: messages.id,
			createdAt: messages.createdAt,
			position: sql<number>`row_number() over (partition by ${threadKey} order by ${messages.createdAt} desc, ${messages.id} desc)`.as("position"),
		})
		.from(messages)
		.where(where)
		.as("conversation_heads");

	// Always two queries, even for deep pages or threads with many messages.
	const [totals, heads] = await Promise.all([
		db.select({ total: countDistinct(threadKey) }).from(messages).where(where),
		db
			.select({ id: ranked.id })
			.from(ranked)
			.where(eq(ranked.position, 1))
			.orderBy(desc(ranked.createdAt), desc(ranked.id))
			.limit(limit)
			.offset(offset),
	]);

	return { ids: heads.map((head) => head.id), total: totals[0]?.total ?? 0 };
}

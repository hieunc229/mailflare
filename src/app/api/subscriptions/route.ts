import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { parseLimit, parseOffset } from "@/lib/api/query-params";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { loadPromotionModes } from "@/lib/promotions/settings";
import { listSubscriptions } from "@/lib/promotions/subscriptions";
import { SUBSCRIPTIONS_PAGE_SIZE } from "@/lib/promotions/subscriptions-utils";

const EMPTY = { senders: [], total: 0 };

/**
 * Promotional senders of one mailbox over the last 90 days. No mailbox, an unreadable one and a mailbox with
 * Promotions off all answer an empty list (the page shows its empty state), never an error.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const params = new URL(request.url).searchParams;
	const mailboxId = params.get("mailboxId");
	if (!mailboxId) return NextResponse.json(EMPTY);

	const db = getDb(env);
	if (!(await getMailboxAccessLevel(db, user, mailboxId))?.canRead) return NextResponse.json(EMPTY);
	if (((await loadPromotionModes(db, [mailboxId])).get(mailboxId) ?? "off") === "off") return NextResponse.json({ ...EMPTY, mode: "off" });

	try {
		return NextResponse.json(await listSubscriptions(db, {
			mailboxId,
			offset: parseOffset(params.get("offset")),
			limit: parseLimit(params.get("limit"), SUBSCRIPTIONS_PAGE_SIZE, SUBSCRIPTIONS_PAGE_SIZE),
		}));
	} catch (error) {
		// The category and sender columns arrive with the migration; before it there is nothing to list.
		if (isMissingTableError(error) || /no such column|does not exist|unknown column/i.test(String((error as Error)?.cause ?? error))) return NextResponse.json(EMPTY);
		throw error;
	}
}

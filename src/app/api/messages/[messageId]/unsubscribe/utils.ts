import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { LIKE_ESCAPE, escapeLike } from "@/db/sql";
import { messages } from "@/db/schema";
import { assertResolvesPublic, isPublicHttpsUrl } from "@/lib/security/public-url";

const ONE_CLICK_TIMEOUT_MS = 10_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

const windows = new Map<string, { start: number; count: number }>();

/** Fixed-window limit on unsubscribe attempts per user; keeps the mailto path from being an outbound amplifier. */
export function allowUnsubscribeRequest(userId: string, now = Date.now()): boolean {
	const current = windows.get(userId);
	if (!current || now - current.start >= WINDOW_MS) {
		windows.set(userId, { start: now, count: 1 });
		return true;
	}
	current.count += 1;
	return current.count <= MAX_REQUESTS;
}

/**
 * RFC 8058 one-click: POST `List-Unsubscribe=One-Click` to the https URI.
 * Any 2xx or 3xx counts as success; redirects are never followed, so the
 * endpoint cannot bounce the request to an internal address.
 */
export async function postOneClickUnsubscribe(url: string): Promise<boolean> {
	if (!isPublicHttpsUrl(url)) return false;
	try {
		await assertResolvesPublic(new URL(url).hostname);
	} catch {
		return false;
	}
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
			signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
		});
		return response.status >= 200 && response.status < 400;
	} catch {
		return false;
	}
}

/**
 * Past inbound mail from exactly this sender address that a sweep would move to Trash. The stored From is
 * either the bare address or `Name <address>`, so match the whole value or the bracketed address at the end,
 * never a substring of some other address. Starred mail and mail filed by the user stay put.
 */
export function senderTrashCondition(mailboxId: string, senderAddress: string) {
	const fromAddr = sql`lower(${messages.fromAddr})`;
	const bracketed = sql`${fromAddr} like ${`%<${escapeLike(senderAddress)}>`} escape ${sql.raw(`'${LIKE_ESCAPE}'`)}`;
	return and(
		eq(messages.mailboxId, mailboxId),
		eq(messages.direction, "inbound"),
		or(sql`${fromAddr} = ${senderAddress}`, bracketed),
		eq(messages.starred, false),
		isNull(messages.folderId),
		ne(messages.status, "trash"),
	);
}

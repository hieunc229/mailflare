import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageUnsubscribe } from "@/db/schema";
import { extractUnsubscribeUrlFromRaw, fromStoredUnsubscribe, toStoredUnsubscribe } from "@/lib/email/unsubscribe";
import type { UnsubscribeUrl } from "@/lib/email/unsubscribe-types";

const maxHeaderBytes = 64 * 1024;

/** Stores a derived candidate (null = "computed: no header"). Best effort: a missing table (deploy before migrate) or a deleted message never fails the caller. */
export async function recordUnsubscribe(env: Pick<CloudflareEnv, "DB">, messageId: string, candidate: UnsubscribeUrl): Promise<void> {
	try {
		await getDb(env).insert(messageUnsubscribe).values({ messageId, ...toStoredUnsubscribe(candidate) }).onConflictDoNothing();
	} catch (error) {
		console.warn("Storing unsubscribe data failed", { messageId, error });
	}
}

/** The stored row as a candidate; `undefined` when not computed yet (or the table is not migrated). */
export async function readStoredUnsubscribe(env: Pick<CloudflareEnv, "DB">, messageId: string): Promise<UnsubscribeUrl | undefined> {
	try {
		const [row] = await getDb(env)
			.select({ url: messageUnsubscribe.url, oneClick: messageUnsubscribe.oneClick, mailto: messageUnsubscribe.mailto, dkimCovers: messageUnsubscribe.dkimCovers })
			.from(messageUnsubscribe)
			.where(eq(messageUnsubscribe.messageId, messageId))
			.limit(1);
		return row ? fromStoredUnsubscribe(row) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * List-Unsubscribe data for a message: the stored row when present, else derived from the raw MIME's
 * header block in R2 (as before) and written back for next time. A missing key or object stores nothing.
 */
export async function resolveUnsubscribe(env: CloudflareEnv, messageId: string, rawR2Key: string | null): Promise<UnsubscribeUrl> {
	if (!rawR2Key) return null;
	const stored = await readStoredUnsubscribe(env, messageId);
	if (stored !== undefined) return stored;
	const raw = await env.BUCKET.get(rawR2Key, { range: { offset: 0, length: maxHeaderBytes } });
	if (!raw) return null;
	const candidate = extractUnsubscribeUrlFromRaw(await raw.arrayBuffer());
	await recordUnsubscribe(env, messageId, candidate);
	return candidate;
}

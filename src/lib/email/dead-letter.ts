import type { InboundQueueMessage } from "@/lib/email/inbound";

/** Raw mail that exhausted its queue retries moves here; the orphan sweeper only walks `inbound/`, so it is kept. */
export const DEAD_INBOUND_PREFIX = "dead/";

/**
 * Moves the raw MIME of an inbound message that can no longer be retried out of `inbound/`, so the daily
 * sweep does not delete the only copy. The envelope and the last error go in the object's custom metadata
 * (R2 allows 2 KB in total), enough to re-inject it by hand. Returns the new key, or null when the raw object
 * is already gone.
 */
export async function deadLetterInboundMail(env: Pick<CloudflareEnv, "BUCKET">, payload: InboundQueueMessage, error: unknown): Promise<string | null> {
	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) return null;
	const key = `${DEAD_INBOUND_PREFIX}${payload.rawR2Key.replace(/^inbound\//, "")}`;
	const reason = error instanceof Error ? error.message : String(error);
	await env.BUCKET.put(key, await raw.arrayBuffer(), {
		customMetadata: {
			from: payload.from.slice(0, 320),
			to: payload.to.slice(0, 320),
			failedAt: new Date().toISOString(),
			error: reason.slice(0, 500),
		},
	});
	await env.BUCKET.delete(payload.rawR2Key);
	return key;
}

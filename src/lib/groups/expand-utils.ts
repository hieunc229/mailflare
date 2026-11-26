/** Members expanded per queue invocation, so one message stays within Worker subrequest limits. */
export const GROUP_EXPANSION_CHUNK = 40;

/** Cloudflare Queues: at most 100 messages and 256 KB per `sendBatch`; keep margin under the byte cap. */
export const QUEUE_BATCH_MAX_COUNT = 100;
export const QUEUE_BATCH_MAX_BYTES = 200_000;

/**
 * Splits rows fetched in id order (one more than `size` when more remain) into this chunk and the
 * cursor for the next one (the last id of the chunk), or null when this is the last chunk.
 */
export function planChunk<T extends { id: string }>(rows: T[], size: number): { chunk: T[]; nextCursor: string | null } {
	const chunk = rows.slice(0, size);
	return { chunk, nextCursor: rows.length > size ? chunk[chunk.length - 1].id : null };
}

/** Mailboxes that get a copy: each once, minus the poster's own mailbox (it already has a Sent copy). */
export function planDeliveries(targets: { mailboxId: string }[], senderMailboxId: string | null): string[] {
	const ids = new Set<string>();
	for (const target of targets) if (target.mailboxId !== senderMailboxId) ids.add(target.mailboxId);
	return [...ids];
}

/** Groups queue messages into `sendBatch` calls under both the count and the size limit. */
export function planQueueBatches<T extends { body: unknown }>(
	messages: T[],
	limits: { maxCount: number; maxBytes: number } = { maxCount: QUEUE_BATCH_MAX_COUNT, maxBytes: QUEUE_BATCH_MAX_BYTES },
): T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	let bytes = 0;
	for (const message of messages) {
		const size = JSON.stringify(message.body).length;
		if (current.length && (current.length >= limits.maxCount || bytes + size > limits.maxBytes)) {
			batches.push(current);
			current = [];
			bytes = 0;
		}
		current.push(message);
		bytes += size;
	}
	if (current.length) batches.push(current);
	return batches;
}

/** True when a mailbox at `localPart@hostname` is the account's own address (`users.email`). */
export function isAccountPrimaryAddress(localPart: string, hostname: string, accountEmail: string): boolean {
	return `${localPart}@${hostname}`.toLowerCase() === accountEmail.trim().toLowerCase();
}

/**
 * Storage key of one member's copy. It is derived from the original raw key, so a redelivered
 * chunk writes the same objects and the consumer's `(mailboxId, rawR2Key)` dedupe skips them.
 * (Hashing the bytes, as `inboundStorageKey` does, would cost 40 SHA-256 passes over up to 25 MB.)
 */
export async function groupCopyKey(rawR2Key: string, mailboxId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`group-copy\0${mailboxId}\0${rawR2Key}`));
	return `inbound/${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}.eml`;
}

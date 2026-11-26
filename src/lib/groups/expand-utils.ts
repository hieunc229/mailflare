/**
 * Members expanded per queue invocation. Each member costs an R2 put, and a chunk adds about ten
 * queries, so 20 stays under the 50 subrequests of an invocation on the Free plan.
 */
export const GROUP_EXPANSION_CHUNK = 20;

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

/** SHA-256 of the message bytes, hex: one pass per chunk, however many members get a copy. */
export async function contentDigest(bytes: ArrayBuffer): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function hex(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Storage key of one member's copy, from the message content and the mailbox. It does not depend
 * on which group sent it: a mailbox in two groups addressed in one message gets the same key twice,
 * so the consumer's `(mailboxId, rawR2Key)` dedupe stores one copy. A redelivered chunk rewrites
 * the same objects. (Hashing the bytes per member, as `inboundStorageKey` does, would cost 20
 * SHA-256 passes over up to 25 MB.)
 */
export async function groupCopyKey(digest: string, mailboxId: string): Promise<string> {
	return `inbound/${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`group-copy\0${mailboxId}\0${digest}`)))}.eml`;
}

/** Subrequests one chunk can use at most: its copies (or relay messages) plus the queries, relay copy, queue sends and cleanup around them. */
export const EXPANSION_CHUNK_COST = GROUP_EXPANSION_CHUNK + 15;
/** What expansion may spend in one queue batch: under the 50 subrequests of an invocation on the Free plan. */
export const EXPANSION_SUBREQUEST_BUDGET = 45;

export type ExpansionBudget = { remaining: number; started: boolean };

/** One per queue batch. A batch holds several messages and runs them in one invocation. */
export const createExpansionBudget = (): ExpansionBudget => ({ remaining: EXPANSION_SUBREQUEST_BUDGET, started: false });

/**
 * Claims a chunk's worth of subrequests. The first chunk of a batch always runs, so expansion
 * makes progress; later ones return false and are re-enqueued with a delay, never dropped.
 */
export function reserveExpansion(budget: ExpansionBudget): boolean {
	if (budget.started && EXPANSION_CHUNK_COST > budget.remaining) return false;
	budget.started = true;
	budget.remaining -= EXPANSION_CHUNK_COST;
	return true;
}

/** Seconds a deferred chunk waits before the queue offers it again. */
export const EXPANSION_DEFER_SECONDS = 5;

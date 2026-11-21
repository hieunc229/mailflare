/**
 * Sent-copy dedupe (spec 9.4). A message sent through the submission service already has its Sent row; most
 * mail apps then APPEND the same message to Sent as well. The submission layer calls `rememberSubmission`
 * with the client's own Message-ID header and the Mailflare message it created; an APPEND to Sent whose
 * Message-ID matches within 15 minutes is answered with the existing row and stores nothing.
 *
 * In memory and per process (IMAP runs in one process, spec section 2): after a restart a duplicate is possible.
 * Bounded in entries, oldest dropped first.
 */
export const DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;

type Entry = { messageId: string; mailboxId: string; at: number };
const entries = new Map<string, Entry>();

/** A Message-ID without its angle brackets or surrounding space; two spellings of one id compare equal. */
const normalize = (header: string) => header.trim().replace(/^<|>$/g, "");
const keyOf = (userId: string, header: string) => `${userId}\0${normalize(header)}`;

export function rememberSubmission(userId: string, messageIdHeader: string | null | undefined, messageId: string, mailboxId: string, now = Date.now()): void {
	if (!messageIdHeader || !normalize(messageIdHeader)) return;
	const key = keyOf(userId, messageIdHeader);
	entries.delete(key);
	entries.set(key, { messageId, mailboxId, at: now });
	for (const [oldKey, entry] of entries) {
		if (entries.size <= MAX_ENTRIES && now - entry.at < DEDUPE_WINDOW_MS) break;
		entries.delete(oldKey);
	}
}

/** The Mailflare message and mailbox a submission with this Message-ID created for this user in the last 15 minutes. */
export function findSubmission(userId: string, messageIdHeader: string | null | undefined, now = Date.now()): { messageId: string; mailboxId: string } | null {
	if (!messageIdHeader || !normalize(messageIdHeader)) return null;
	const entry = entries.get(keyOf(userId, messageIdHeader));
	if (!entry) return null;
	if (now - entry.at >= DEDUPE_WINDOW_MS) {
		entries.delete(keyOf(userId, messageIdHeader));
		return null;
	}
	return { messageId: entry.messageId, mailboxId: entry.mailboxId };
}

export function clearSubmissionMemory(): void {
	entries.clear();
}

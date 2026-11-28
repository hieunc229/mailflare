import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapMessageFlags, messages } from "@/db/schema";
import { updateUnlessChangedSince } from "@/lib/jmap/emails";
import { processRequest } from "@/lib/jmap/processor";
import { imapContext, type ImapIdentity } from "./auth";
import { ImapError, bad, no } from "./errors";
import { syncMailbox } from "./sync";
import { loadMessageRows, type MessageFlagsRow } from "./view";

/**
 * STORE: which flags a client may set and how they land in Mailflare (spec 8.2).
 * `\Seen` and `\Flagged` are the `read` and `starred` columns and are written through
 * the JMAP `Email/set` handler, so the permission rule and the change log are the
 * ones JMAP has. `\Answered`, `$Forwarded`, `\Deleted` and other keywords live in
 * `imap_message_flags`; a write there also touches the message row, which makes the
 * change log record an update, so the sync engine gives the UID its next mod-sequence
 * through the one allocation every writer shares.
 */
export const MAX_KEYWORDS = 50;
export const MAX_KEYWORD_LENGTH = 64;
/** Flags in one STORE command, as the client wrote them. */
const MAX_FLAG_WORDS = 100;
/** Messages one STORE may touch. */
export const MAX_STORE_MESSAGES = 20_000;
/** Messages per write step: two statements each stay far below a batch's limits. */
const STEP = 25;
const JMAP_STEP = 90;

/** What a keyword may look like on the wire: an atom, so it can never carry a line break or a delimiter. */
const KEYWORD_CHARS = new Set("!#$&'+,.0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~-");
export const isKeywordAtom = (value: string) => value.length > 0 && value.length <= MAX_KEYWORD_LENGTH && [...value].every((char) => KEYWORD_CHARS.has(char));

export type FlagMode = "add" | "remove" | "replace";

export type ParsedFlags = {
	seen: boolean;
	flagged: boolean;
	answered: boolean;
	deleted: boolean;
	forwarded: boolean;
	/** Keywords in the spelling the client used, without duplicates (compared case-insensitively). */
	keywords: string[];
};

/** System flags that exist but are not stored: `\Draft` follows the folder, `\Recent` is never set by a client. */
const IGNORED_SYSTEM = new Set(["\\draft", "\\recent"]);
const STORED_SYSTEM = new Set(["\\seen", "\\flagged", "\\answered", "\\deleted"]);

/** The flag words of one STORE or APPEND; a word that is neither a system flag nor an atom of at most 64 characters is a syntax error. */
export function parseFlagWords(words: string[]): ParsedFlags {
	if (words.length > MAX_FLAG_WORDS) throw bad("Too many flags");
	const parsed: ParsedFlags = { seen: false, flagged: false, answered: false, deleted: false, forwarded: false, keywords: [] };
	const seen = new Set<string>();
	for (const word of words) {
		const lower = word.toLowerCase();
		if (word.startsWith("\\")) {
			if (STORED_SYSTEM.has(lower)) parsed[lower.slice(1) as "seen" | "flagged" | "answered" | "deleted"] = true;
			else if (!IGNORED_SYSTEM.has(lower)) {
				if (!/^\\[A-Za-z][A-Za-z0-9]{0,63}$/.test(word)) throw bad("A flag is not valid");
				// A system flag this server does not know is accepted and not kept, as RFC 3501 allows.
			}
			continue;
		}
		if (!isKeywordAtom(word)) throw bad("A flag is not valid");
		if (lower === "$forwarded") {
			parsed.forwarded = true;
			continue;
		}
		if (seen.has(lower)) continue;
		seen.add(lower);
		parsed.keywords.push(word);
	}
	return parsed;
}

export type NextFlags = { read: boolean; starred: boolean; answered: boolean; forwarded: boolean; deleted: boolean; keywords: string[] };

function storedKeywords(row: MessageFlagsRow): string[] {
	if (!row.keywords) return [];
	try {
		const parsed: unknown = JSON.parse(row.keywords);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && isKeywordAtom(item)).slice(0, MAX_KEYWORDS) : [];
	} catch {
		return [];
	}
}

/** The flags a message has after STORE applied `parsed` to `row` by `mode`. */
export function nextFlags(row: MessageFlagsRow, mode: FlagMode, parsed: ParsedFlags): NextFlags {
	const current: NextFlags = { read: row.read, starred: row.starred, answered: !!row.answered, forwarded: !!row.forwarded, deleted: !!row.deleted, keywords: storedKeywords(row) };
	if (mode === "replace") {
		return { read: parsed.seen, starred: parsed.flagged, answered: parsed.answered, forwarded: parsed.forwarded, deleted: parsed.deleted, keywords: parsed.keywords };
	}
	const value = mode === "add";
	const next = { ...current };
	if (parsed.seen) next.read = value;
	if (parsed.flagged) next.starred = value;
	if (parsed.answered) next.answered = value;
	if (parsed.deleted) next.deleted = value;
	if (parsed.forwarded) next.forwarded = value;
	const named = new Set(parsed.keywords.map((keyword) => keyword.toLowerCase()));
	if (value) {
		const have = new Set(current.keywords.map((keyword) => keyword.toLowerCase()));
		next.keywords = [...current.keywords, ...parsed.keywords.filter((keyword) => !have.has(keyword.toLowerCase()))];
	} else next.keywords = current.keywords.filter((keyword) => !named.has(keyword.toLowerCase()));
	return next;
}

/** One call through the JMAP handlers, as this login. */
export async function jmapCall(env: CloudflareEnv, identity: ImapIdentity, method: string, args: Record<string, unknown>, guard?: { mailboxId: string; jmapSeq: number }): Promise<Record<string, unknown>> {
	const context = imapContext(env, identity.auth);
	if (guard) context.emailUpdateGuard = { mailboxId: guard.mailboxId, jmapSeq: guard.jmapSeq };
	const response = await processRequest(context, { using: [], methodCalls: [[method, args, "call"]] });
	const [name, body] = response.methodResponses[0];
	if (name === "error") throw no("The change could not be made", "SERVERBUG");
	return body;
}

export async function jmapEmailSet(env: CloudflareEnv, identity: ImapIdentity, args: Record<string, unknown>, guard?: { mailboxId: string; jmapSeq: number }) {
	return (await jmapCall(env, identity, "Email/set", args, guard)) as { updated?: Record<string, unknown>; notUpdated?: Record<string, { type?: string }>; destroyed?: string[]; notDestroyed?: Record<string, { type?: string }> };
}

const chunksOf = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/**
 * STORE ... UNCHANGEDSINCE: `jmapSeq` is the change-log position of the check (read right after its sync). A message that has
 * a change logged after it is not written, checked in the statement that writes, and its id is added to `unwritten`.
 */
export type StoreGuard = { jmapSeq: number; unwritten: Set<string> };

/**
 * Applies the flag change to the messages of one folder of a mailbox and brings the IMAP state up to date.
 * Returns the ids that are in that folder (the ones the client is told about). Writing is
 * refused up front when the login may not write, so a partly applied command is not a result of permissions.
 * With a `guard`, each message's write is conditional on the change log (see `StoreGuard`).
 */
export async function storeFlags(env: CloudflareEnv, identity: ImapIdentity, mailboxId: string, folderKey: string, ids: string[], mode: FlagMode, parsed: ParsedFlags, guard?: StoreGuard): Promise<string[]> {
	const db = getDb(env);
	const found: string[] = [];
	const writeImapOnly = async (rows: Array<{ id: string; next: NextFlags }>) => {
		if (!rows.length) return;
		const now = Math.floor(Date.now() / 1000);
		await db.batch(
			rows.flatMap(({ id, next }) => {
				const values = { answered: next.answered, forwarded: next.forwarded, deleted: next.deleted, keywords: JSON.stringify(next.keywords), updatedAt: now };
				return [
					db.insert(imapMessageFlags).values({ messageId: id, ...values }).onConflictDoUpdate({ target: imapMessageFlags.messageId, set: values }),
					// The touch writes the column's own value back, so a change another client made meanwhile is kept.
					db.update(messages).set({ read: sql`${messages.read}` }).where(and(eq(messages.id, id), eq(messages.mailboxId, mailboxId))),
				];
			}) as never,
		);
	};
	for (const group of chunksOf(ids, STEP)) {
		const rows = await loadMessageRows(env, mailboxId, identity.userId, group, folderKey);
		const changes: Array<{ id: string; row: MessageFlagsRow; next: NextFlags }> = [];
		for (const id of group) {
			const row = rows.get(id);
			if (!row) continue;
			found.push(id);
			const next = nextFlags(row, mode, parsed);
			if (next.keywords.length > MAX_KEYWORDS) throw no("A message would have more than 50 keywords", "LIMIT");
			changes.push({ id, row, next });
		}
		const imapOnly = changes.filter(({ row, next }) => next.answered !== !!row.answered || next.forwarded !== !!row.forwarded || next.deleted !== !!row.deleted || JSON.stringify(next.keywords) !== JSON.stringify(storedKeywords(row)));
		const marks = changes.filter(({ row, next }) => next.read !== row.read || next.starred !== row.starred);
		// Unconditionally the IMAP-only flags and the touch of the message row go first, together.
		if (!guard) await writeImapOnly(imapOnly);
		for (const part of chunksOf(marks, JMAP_STEP)) {
			const update: Record<string, Record<string, boolean>> = {};
			for (const { id, row, next } of part) {
				update[id] = {
					...(next.read !== row.read ? { "keywords/$seen": next.read } : {}),
					...(next.starred !== row.starred ? { "keywords/$flagged": next.starred } : {}),
				};
			}
			const result = await jmapEmailSet(env, identity, { update }, guard && { mailboxId, jmapSeq: guard.jmapSeq });
			for (const [id, failure] of Object.entries(result.notUpdated ?? {})) {
				if (failure.type === "forbidden") throw no("You may not change this mailbox", "NOPERM");
				if (guard && failure.type === "changedSince") guard.unwritten.add(id);
			}
		}
		if (guard) {
			// A message with IMAP-only changes is first checked by its own write (a message with a read or starred change was checked by the one above, which
			// is also the touch), and only then are its IMAP-only flags stored, with the touch that gives the UID a new mod-sequence for them.
			const marked = new Set(marks.map(({ id }) => id));
			const checked = new Set<string>();
			const pending = imapOnly.filter(({ id }) => !marked.has(id)).map(({ id }) => id);
			for (const part of chunksOf(pending, JMAP_STEP)) {
				const changed = await updateUnlessChangedSince(env, db, { mailboxId, jmapSeq: guard.jmapSeq }, part, { read: sql`${messages.read}` });
				for (const id of part) {
					if (changed.has(id)) guard.unwritten.add(id);
					else checked.add(id);
				}
			}
			await writeImapOnly(imapOnly.filter(({ id }) => (marked.has(id) ? !guard.unwritten.has(id) : checked.has(id))));
		}
	}
	await syncMailbox(env, mailboxId);
	return found;
}

export { ImapError };

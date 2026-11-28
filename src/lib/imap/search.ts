import { and, eq, gte, isNull, lt, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { imapMessageFlags, imapUids, messages } from "@/db/schema";
import { containsLike } from "@/db/sql";
import { parseModseq } from "./condstore";
import { bad, no } from "./errors";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import { MimeIndexError, getMessageIndex, readSection } from "./fetch";
import { parseSequenceSet, selectByNumber, selectByUid, type SetRange } from "./sets";
import type { FolderView } from "./view";

/**
 * SEARCH (RFC 3501 section 6.4.4). The criteria become a small tree; each leaf is
 * answered either by one SQL query over the folder (flags, dates, addresses, subject,
 * body text) or in memory over a bounded set of candidates (other headers, sizes), and
 * the tree is evaluated as set algebra over UIDs. Matching is a case-insensitive
 * substring match, as RFC 3501 requires. Limits: 64 keys in one command (every key,
 * group, NOT and OR counted), 32 levels of nesting, search strings of at most 2048
 * octets, and 2000 messages in all for the tests of one command that have to read
 * message data (a wider search is refused with NO [LIMIT]).
 */
export type SearchKey =
	| { t: "all" }
	| { t: "none" }
	| { t: "not"; key: SearchKey }
	| { t: "or"; a: SearchKey; b: SearchKey }
	| { t: "and"; keys: SearchKey[] }
	| { t: "set"; ranges: SetRange[]; byUid: boolean }
	| { t: "flag"; flag: "seen" | "flagged" | "draft" | "answered" | "deleted" | "forwarded" }
	| { t: "keyword"; name: string }
	| { t: "text"; field: "from" | "to" | "cc" | "bcc" | "subject" | "body" | "text"; value: string }
	| { t: "date"; op: "before" | "on" | "since"; day: number }
	| { t: "header"; name: string; value: string }
	| { t: "size"; op: "larger" | "smaller"; bytes: number }
	| { t: "modseq"; value: number };

export const MAX_DEPTH = 32;
export const MAX_STRING = 2048;
export const MEMORY_LIMIT = 2000;
export const MAX_KEYS = 64;

type Node = { type?: string; value?: unknown } | Node[] | null;
type Cursor = { items: Node[]; at: number; keys: { count: number } };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = 86_400_000;

function atom(node: Node | undefined): string | null {
	return node && !Array.isArray(node) && typeof node.value === "string" && node.type !== "STRING" && node.type !== "LITERAL" ? node.value : null;
}

/** Search text: octets as the client sent them, read as UTF-8 for CHARSET UTF-8 and as ASCII for CHARSET US-ASCII. */
export type Decoder = (octets: string) => string | null;

function stringArg(cursor: Cursor, decode: Decoder): string {
	const node = cursor.items[cursor.at++];
	if (!node || Array.isArray(node) || typeof node.value !== "string") throw bad("A search string is missing");
	if (node.value.length > MAX_STRING) throw bad("A search string is too long");
	const text = decode(node.value);
	if (text === null) throw no("The search string is not in the stated charset", "BADCHARSET (UTF-8 US-ASCII)");
	return text;
}

function dateArg(cursor: Cursor): number {
	const node = cursor.items[cursor.at++];
	const text = node && !Array.isArray(node) && typeof node.value === "string" ? node.value : "";
	const [day, month, year, ...extra] = text.split("-");
	const monthIndex = MONTHS.indexOf((month ?? "").toLowerCase());
	const dayNumber = Number(day);
	const yearNumber = Number(year);
	if (extra.length || monthIndex < 0 || !/^\d{1,2}$/.test(day ?? "") || !/^\d{4}$/.test(year ?? "") || dayNumber < 1 || dayNumber > 31) throw bad("A search date is not valid");
	const when = Date.UTC(yearNumber, monthIndex, dayNumber);
	if (new Date(when).getUTCDate() !== dayNumber) throw bad("A search date is not valid");
	return when;
}

function numberArg(cursor: Cursor): number {
	const text = atom(cursor.items[cursor.at++]) ?? "";
	if (!/^\d{1,10}$/.test(text)) throw bad("A search size is not valid");
	return Number(text);
}

const HEADER_NAME_CHARS = /^[\x21-\x39\x3b-\x7e]{1,128}$/;

function parseKey(cursor: Cursor, decode: Decoder, depth: number): SearchKey {
	if (depth > MAX_DEPTH) throw bad("The search is nested too deeply");
	const node = cursor.items[cursor.at++];
	if (node === undefined) throw bad("A search key is missing");
	if (++cursor.keys.count > MAX_KEYS) throw bad("The search has too many keys");
	if (Array.isArray(node)) {
		const inner: Cursor = { items: node, at: 0, keys: cursor.keys };
		const keys: SearchKey[] = [];
		while (inner.at < node.length) keys.push(parseKey(inner, decode, depth + 1));
		if (!keys.length) throw bad("An empty search group");
		return { t: "and", keys };
	}
	const type = node?.type;
	const value = typeof node?.value === "string" ? node.value : "";
	if (type === "SEQUENCE" || (type === "ATOM" && /^[\d*]/.test(value))) {
		const ranges = parseSequenceSet(value);
		if (!ranges) throw bad("A message set is not valid");
		return { t: "set", ranges, byUid: false };
	}
	if (type !== "ATOM") throw bad("A search key is not valid");
	const name = value.toUpperCase();
	switch (name) {
		case "ALL": return { t: "all" };
		case "ANSWERED": return { t: "flag", flag: "answered" };
		case "DELETED": return { t: "flag", flag: "deleted" };
		case "DRAFT": return { t: "flag", flag: "draft" };
		case "FLAGGED": return { t: "flag", flag: "flagged" };
		case "SEEN": return { t: "flag", flag: "seen" };
		case "UNANSWERED": return { t: "not", key: { t: "flag", flag: "answered" } };
		case "UNDELETED": return { t: "not", key: { t: "flag", flag: "deleted" } };
		case "UNDRAFT": return { t: "not", key: { t: "flag", flag: "draft" } };
		case "UNFLAGGED": return { t: "not", key: { t: "flag", flag: "flagged" } };
		case "UNSEEN": return { t: "not", key: { t: "flag", flag: "seen" } };
		// No message is ever \Recent here (RFC 3501 allows a server to say so).
		case "RECENT": case "NEW": return { t: "none" };
		case "OLD": return { t: "all" };
		case "BCC": case "CC": case "FROM": case "SUBJECT": case "TO": case "BODY": case "TEXT":
			return { t: "text", field: name.toLowerCase() as "from", value: stringArg(cursor, decode) };
		case "BEFORE": case "ON": case "SINCE": return { t: "date", op: name.toLowerCase() as "before", day: dateArg(cursor) };
		case "SENTBEFORE": case "SENTON": case "SENTSINCE": return { t: "date", op: name.slice(4).toLowerCase() as "before", day: dateArg(cursor) };
		case "KEYWORD": case "UNKEYWORD": {
			const keyword = atom(cursor.items[cursor.at++]);
			if (!keyword || keyword.length > 64) throw bad("A keyword is not valid");
			const key: SearchKey = { t: "keyword", name: keyword };
			return name === "KEYWORD" ? key : { t: "not", key };
		}
		case "LARGER": case "SMALLER": return { t: "size", op: name.toLowerCase() as "larger", bytes: numberArg(cursor) };
		case "HEADER": {
			const named = cursor.items[cursor.at++];
			const field = named && !Array.isArray(named) && typeof named.value === "string" ? named.value : null;
			if (!field || !HEADER_NAME_CHARS.test(field)) throw bad("A header name is not valid");
			return { t: "header", name: field.toLowerCase(), value: stringArg(cursor, decode) };
		}
		case "MODSEQ": {
			// `MODSEQ n`, or `MODSEQ "/flags/\\Seen" all n` (RFC 7162 section 3.1.5): the entry says which metadata, and this server has one mod-sequence per message.
			const first = cursor.items[cursor.at];
			if (atom(first) === null || !/^\d+$/.test(atom(first)!)) {
				const entry = cursor.items[cursor.at++];
				const kind = atom(cursor.items[cursor.at++])?.toLowerCase();
				if (!entry || Array.isArray(entry) || typeof entry.value !== "string" || entry.value.length > 256 || !kind || !["shared", "priv", "all"].includes(kind)) throw bad("MODSEQ takes an entry name and type, or just a mod-sequence");
			}
			const value = parseModseq(atom(cursor.items[cursor.at++]) ?? "");
			if (value === null) throw bad("MODSEQ takes a mod-sequence");
			return { t: "modseq", value };
		}
		case "NOT": return { t: "not", key: parseKey(cursor, decode, depth + 1) };
		case "OR": return { t: "or", a: parseKey(cursor, decode, depth + 1), b: parseKey(cursor, decode, depth + 1) };
		case "UID": {
			const ranges = parseSequenceSet(atom(cursor.items[cursor.at++]) ?? "");
			if (!ranges) throw bad("A UID set is not valid");
			return { t: "set", ranges, byUid: true };
		}
		default: throw bad("A search key is not supported");
	}
}

/** Whether the search names MODSEQ anywhere: the answer then reports the highest mod-sequence found. */
export function usesModseq(key: SearchKey): boolean {
	switch (key.t) {
		case "modseq": return true;
		case "not": return usesModseq(key.key);
		case "or": return usesModseq(key.a) || usesModseq(key.b);
		case "and": return key.keys.some(usesModseq);
		default: return false;
	}
}

/** The criteria after an optional `CHARSET name`: an implicit AND of every key. */
export function parseSearchCriteria(items: Node[], decode: Decoder): SearchKey {
	const cursor: Cursor = { items, at: 0, keys: { count: 0 } };
	const keys: SearchKey[] = [];
	while (cursor.at < items.length) keys.push(parseKey(cursor, decode, 1));
	if (!keys.length) throw bad("The search has no keys");
	return keys.length === 1 ? keys[0] : { t: "and", keys };
}

/** The decoder for a CHARSET name; null when the charset is not one this server handles. */
export function decoderFor(charset: string | null): Decoder | null {
	if (charset === null || charset.toUpperCase() === "UTF-8") {
		return (octets) => {
			try {
				return new TextDecoder("utf-8", { fatal: charset !== null }).decode(Buffer.from(octets, "latin1"));
			} catch {
				return null;
			}
		};
	}
	if (charset.toUpperCase() === "US-ASCII") return (octets) => ([...octets].every((char) => char.charCodeAt(0) < 128) ? octets : null);
	return null;
}

// ---- Evaluation ----

const bodyMatches = (term: string) => or(containsLike(messages.textBody, term), and(isNull(messages.textBody), containsLike(messages.htmlBody, term)))!;

/** The SQL condition for a leaf, or null when only the message data can answer it. */
function predicate(key: SearchKey): SQL | null {
	switch (key.t) {
		case "flag":
			switch (key.flag) {
				case "seen": return eq(messages.read, true);
				case "flagged": return eq(messages.starred, true);
				case "draft": return eq(messages.status, "draft");
				case "answered": return eq(imapMessageFlags.answered, true);
				case "deleted": return eq(imapMessageFlags.deleted, true);
				default: return eq(imapMessageFlags.forwarded, true);
			}
		case "keyword":
			// `$Forwarded` is stored in its own column; every other keyword is an element of the JSON list.
			if (key.name.toLowerCase() === "$forwarded") return eq(imapMessageFlags.forwarded, true);
			return containsLike(imapMessageFlags.keywords, `"${key.name}"`);
		case "text":
			switch (key.field) {
				case "from": return containsLike(messages.fromAddr, key.value);
				case "to": return containsLike(messages.toAddr, key.value);
				case "cc": return containsLike(messages.ccAddr, key.value);
				case "bcc": return containsLike(messages.bccAddr, key.value);
				case "subject": return containsLike(messages.subject, key.value);
				case "body": return bodyMatches(key.value);
				default: return or(containsLike(messages.fromAddr, key.value), containsLike(messages.toAddr, key.value), containsLike(messages.ccAddr, key.value), containsLike(messages.bccAddr, key.value), containsLike(messages.subject, key.value), bodyMatches(key.value))!;
			}
		case "date":
			// Mailflare keeps one time per message, when it was received or sent, so the SENT* keys use it too.
			if (key.op === "since") return gte(messages.createdAt, new Date(key.day));
			if (key.op === "before") return lt(messages.createdAt, new Date(key.day));
			return and(gte(messages.createdAt, new Date(key.day)), lt(messages.createdAt, new Date(key.day + DAY)))!;
		case "modseq": return gte(imapUids.modseq, key.value);
		case "header":
			// The threading headers are columns; every other header needs the message data.
			if (key.name === "message-id") return containsLike(messages.providerMessageId, key.value);
			if (key.name === "in-reply-to") return containsLike(messages.inReplyTo, key.value);
			if (key.name === "references") return containsLike(messages.references, key.value);
			return null;
		default:
			return null;
	}
}

type Env = Pick<CloudflareEnv, "DB" | "BUCKET"> & { MAIL_HOSTNAME?: string };

/** The unfolded value of the first header called `name`, from the header field list of a message. */
function headerValue(data: Uint8Array, name: string): string | null {
	const text = Buffer.from(data).toString("latin1");
	const lines = text.split("\r\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const colon = line.indexOf(":");
		if (colon <= 0 || line.slice(0, colon).trim().toLowerCase() !== name) continue;
		let value = line.slice(colon + 1);
		while (index + 1 < lines.length && /^[ \t]/.test(lines[index + 1])) value += ` ${lines[++index].trim()}`;
		return value.trim();
	}
	return null;
}

export class SearchEvaluator {
	private readonly indexOfUid: Map<number, number>;

	/** `budget`: how many messages this evaluator (one command) may read message data for, over all its tests. */
	constructor(private readonly env: Env, private readonly view: FolderView, private budget = MEMORY_LIMIT) {
		this.indexOfUid = new Map(view.uids.map((uid, index) => [uid, index]));
	}

	/** The UIDs in the folder that match, ascending. */
	async run(key: SearchKey): Promise<number[]> {
		const everything = new Set(this.view.uids);
		const matched = await this.evaluate(key, everything);
		return this.view.uids.filter((uid) => matched.has(uid));
	}

	private async evaluate(key: SearchKey, within: Set<number>): Promise<Set<number>> {
		switch (key.t) {
			case "all": return within;
			case "none": return new Set();
			case "not": {
				const inner = await this.evaluate(key.key, within);
				return new Set([...within].filter((uid) => !inner.has(uid)));
			}
			case "and": {
				let current = within;
				for (const part of key.keys) current = await this.evaluate(part, current);
				return current;
			}
			case "or": {
				const first = await this.evaluate(key.a, within);
				const rest = new Set([...within].filter((uid) => !first.has(uid)));
				const second = await this.evaluate(key.b, rest);
				return new Set([...first, ...second]);
			}
			case "set": {
				const numbers = key.byUid ? selectByUid(key.ranges, this.view.uids) : selectByNumber(key.ranges, this.view.exists);
				return new Set(numbers.map((msn) => this.view.uids[msn - 1]).filter((uid) => within.has(uid)));
			}
			case "size": return this.byMessage(within, async (id) => {
				const bytes = await this.sizeOf(id);
				return key.op === "larger" ? bytes > key.bytes : bytes < key.bytes;
			});
			default: {
				const condition = predicate(key);
				if (condition) return this.query(condition, within);
				if (key.t !== "header") return new Set();
				const needle = key.value.toLowerCase();
				return this.byMessage(within, async (id) => {
					const section = await readSection(this.env, id, { part: "", kind: "header.fields", fields: [key.name] });
					const value = section ? headerValue(section.data, key.name) : null;
					return value !== null && value.toLowerCase().includes(needle);
				});
			}
		}
	}

	private async query(condition: SQL, within: Set<number>): Promise<Set<number>> {
		if (!within.size) return new Set();
		const rows = await getDb(this.env)
			.select({ uid: imapUids.uid })
			.from(imapUids)
			.innerJoin(messages, and(eq(messages.id, imapUids.messageId), eq(messages.mailboxId, imapUids.mailboxId)))
			.leftJoin(imapMessageFlags, eq(imapMessageFlags.messageId, messages.id))
			.where(and(eq(imapUids.mailboxId, this.view.mailboxId), eq(imapUids.folderKey, this.view.folderKey), draftsVisibleTo(this.view.userId), condition));
		return new Set(rows.map((row) => Number(row.uid)).filter((uid) => within.has(uid)));
	}

	private async sizeOf(id: string): Promise<number> {
		try {
			return (await getMessageIndex(this.env, id))?.size ?? 0;
		} catch (error) {
			if (error instanceof MimeIndexError) return 0;
			throw error;
		}
	}

	/** A test that needs message data: every candidate is paid for from the budget of the whole command. */
	private async byMessage(within: Set<number>, test: (messageId: string) => Promise<boolean>): Promise<Set<number>> {
		if (within.size > this.budget) throw no("The search is too broad; narrow it", "LIMIT");
		this.budget -= within.size;
		const result = new Set<number>();
		for (const uid of within) {
			const index = this.indexOfUid.get(uid);
			if (index !== undefined && (await test(this.view.messageIds[index]))) result.add(uid);
		}
		return result;
	}
}

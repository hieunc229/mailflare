import type { ParsedCommand } from "imap-handler";
import { bad, no } from "@/lib/imap/errors";
import { MimeIndexError, getMessageIndex, readSection, reviveLists, type MimeIndex, type SectionSpec } from "@/lib/imap/fetch";
import { changedSince, modseqsOf, parseModseq, vanishedSince } from "@/lib/imap/condstore";
import { parseSequenceSet, resolveRanges, selectByNumber, selectByUid } from "@/lib/imap/sets";
import { parseFlagWords, storeFlags } from "@/lib/imap/flags";
import { flagsOf, loadMessageRows, type MessageFlagsRow } from "@/lib/imap/view";
import type { Completion, ImapConnection } from "../connection";
import { args, isList, text, type Arg } from "./args";

/**
 * FETCH and UID FETCH. The message rows come from the selected mailbox only (the
 * query names the mailbox), and the ENVELOPE, BODYSTRUCTURE and sections come from
 * the F8-2 index of those rows' messages, so nothing is read for a message that is
 * not in the folder the access layer opened.
 */
type Item =
	| { kind: "uid" | "flags" | "internaldate" | "size" | "envelope" | "bodystructure" | "body" | "modseq" }
	| { kind: "section"; label: string; spec: SectionSpec; alias?: string; origin: number | null; peek?: boolean };

const MACROS: Record<string, string[]> = {
	ALL: ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"],
	FAST: ["FLAGS", "INTERNALDATE", "RFC822.SIZE"],
	FULL: ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"],
};

const MAX_PART_DEPTH = 64;
const FIELD_NAME = /^[\x21-\x27\x2a-\x39\x3b-\x5a\x5e-\x7a\x7c\x7e]{1,128}$/;
const MAX_FIELDS = 64;
/** Items in one FETCH, as the client wrote them (a macro counts once). */
const MAX_ITEMS = 64;

/** `HEADER`, `TEXT`, `MIME`, `HEADER.FIELDS`, `HEADER.FIELDS.NOT`, optionally behind a part number such as `1.2.`. */
function parseSection(node: Arg & { section: Arg[] }): { spec: SectionSpec; label: string } {
	const [first, second, ...extra] = node.section;
	if (extra.length) throw bad("The section is not valid");
	if (first === undefined) return { spec: { part: "", kind: "all" }, label: "" };
	const word = text(first);
	if (word === null) throw bad("The section is not valid");
	const pieces = word.split(".");
	const numbers: string[] = [];
	while (pieces.length && /^\d{1,9}$/.test(pieces[0]) && Number(pieces[0]) >= 1) numbers.push(pieces.shift()!);
	if (numbers.length > MAX_PART_DEPTH) throw bad("The part number is too deep");
	const part = numbers.join(".");
	const name = pieces.join(".").toUpperCase();
	const kinds: Record<string, SectionSpec["kind"]> = { "": "all", HEADER: "header", TEXT: "text", MIME: "mime", "HEADER.FIELDS": "header.fields", "HEADER.FIELDS.NOT": "header.fields.not" };
	const kind = kinds[name];
	if (kind === undefined) throw bad("The section is not valid");
	if (kind === "mime" && !part) throw bad("MIME needs a part number");
	const prefix = part ? `${part}.` : "";
	if (kind === "header.fields" || kind === "header.fields.not") {
		if (!isList(second) || !second.length || second.length > MAX_FIELDS) throw bad("The header field list is not valid");
		const fields = second.map((field) => text(field));
		if (fields.some((field) => field === null || !FIELD_NAME.test(field))) throw bad("A header field name is not valid");
		return { spec: { part, kind, fields: fields as string[] }, label: `${prefix}${name} (${(fields as string[]).join(" ")})` };
	}
	if (second !== undefined) throw bad("The section is not valid");
	return { spec: { part, kind }, label: kind === "all" ? part : `${prefix}${name}` };
}

function parseItem(node: Arg): Item[] {
	const word = text(node);
	if (!node || Array.isArray(node) || word === null) throw bad("A FETCH item is not valid");
	const name = word.toUpperCase();
	if (MACROS[name] && !node.section) return MACROS[name].flatMap((item) => parseItem({ type: "ATOM", value: item }));
	const bare = !node.section && !node.partial;
	switch (name) {
		case "UID": case "FLAGS": case "INTERNALDATE": case "ENVELOPE": case "BODYSTRUCTURE": case "MODSEQ":
			if (bare) return [{ kind: name.toLowerCase() as "uid" }];
			break;
		case "RFC822.SIZE": if (bare) return [{ kind: "size" }]; break;
		case "BODY": if (bare) return [{ kind: "body" }]; break;
		case "RFC822": if (bare) return [{ kind: "section", label: "RFC822", alias: "RFC822", spec: { part: "", kind: "all" }, origin: null }]; break;
		case "RFC822.HEADER": if (bare) return [{ kind: "section", label: "RFC822.HEADER", alias: "RFC822.HEADER", spec: { part: "", kind: "header" }, origin: null, peek: true }]; break;
		case "RFC822.TEXT": if (bare) return [{ kind: "section", label: "RFC822.TEXT", alias: "RFC822.TEXT", spec: { part: "", kind: "text" }, origin: null }]; break;
		case "BODY.PEEK": break;
		default: throw bad("A FETCH item is not supported");
	}
	if ((name === "BODY" || name === "BODY.PEEK") && node.section) {
		const { spec, label } = parseSection(node as Arg & { section: Arg[] });
		let origin: number | null = null;
		if (node.partial) {
			if (node.partial.length !== 2 || node.partial[1] < 1) throw bad("The partial range is not valid");
			origin = node.partial[0];
			spec.partial = { offset: node.partial[0], length: node.partial[1] };
		}
		return [{ kind: "section", label, spec, origin, peek: name === "BODY.PEEK" }];
	}
	throw bad("A FETCH item is not supported");
}

// ---- Responses ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");

/** `dd-Mon-yyyy hh:mm:ss +0000`, in UTC. */
export function internalDate(date: Date): string {
	return `${two(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`;
}

const atom = (value: string) => ({ type: "ATOM" as const, value });
const raw = (value: string) => ({ type: "TEXT" as const, value });
const flagList = (flags: string[]) => flags.map(raw);

/** BODY: BODYSTRUCTURE without its extension data (RFC 3501 section 7.4.2). */
export function withoutExtensions(structure: unknown[]): unknown[] {
	const marked = (list: unknown[]) => {
		if (Array.isArray(list[0])) Object.defineProperty(list, "adjacentLists", { value: true });
		return list;
	};
	if (Array.isArray(structure[0])) {
		const children: unknown[] = [];
		let at = 0;
		while (Array.isArray(structure[at])) children.push(withoutExtensions(structure[at++] as unknown[]));
		return marked([...children, structure[at]]);
	}
	const type = String(structure[0]).toLowerCase();
	const subtype = String(structure[1]).toLowerCase();
	const count = type === "text" ? 8 : type === "message" && subtype === "rfc822" ? 10 : 7;
	const basic = structure.slice(0, count);
	if (count === 10 && Array.isArray(basic[8])) basic[8] = withoutExtensions(basic[8] as unknown[]);
	return basic;
}

/** What a message that cannot be indexed is shown as: empty, with a subject that says so. */
const UNINDEXABLE: MimeIndex = {
	size: 0,
	headerSize: 0,
	envelope: [null, "Message cannot be displayed", null, null, null, null, null, null, null, null],
	bodystructure: ["TEXT", "PLAIN", ["CHARSET", "us-ascii"], null, null, "7BIT", 0, 0, null, null, null, null],
	ranges: { "": { span: [0, 0, 0] } },
};

async function indexOf(c: ImapConnection, id: string): Promise<MimeIndex | null> {
	try {
		const index = await getMessageIndex(c.env, id);
		return index ? { ...index, envelope: reviveLists(index.envelope), bodystructure: reviveLists(index.bodystructure) } : null;
	} catch (error) {
		if (error instanceof MimeIndexError) return UNINDEXABLE;
		throw error;
	}
}

async function section(c: ImapConnection, id: string, spec: SectionSpec, unindexable: boolean): Promise<Buffer | null> {
	if (unindexable) return spec.part === "" ? Buffer.alloc(0) : null;
	try {
		const result = await readSection(c.env, id, spec);
		// A view of the bytes that were read: the literal is sent from this memory, never copied again.
		return result ? Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength) : null;
	} catch (error) {
		if (error instanceof MimeIndexError) return spec.part === "" ? Buffer.alloc(0) : null;
		throw error;
	}
}

/** The most octets a section can hold, from the index alone (the same ranges `readSection` reads). */
function sectionBound(index: MimeIndex, spec: SectionSpec): number {
	const entry = index.ranges[spec.part];
	if (!entry) return 0;
	const [start, bodyStart, end] = entry.span;
	const inner = entry.inner;
	let bound: number;
	if (spec.part === "") bound = spec.kind === "all" ? index.size : spec.kind === "text" ? end - bodyStart : spec.kind === "mime" ? 0 : bodyStart - start;
	else if (spec.kind === "all") bound = end - bodyStart;
	else if (spec.kind === "mime") bound = bodyStart - start;
	else bound = inner ? (spec.kind === "text" ? inner[2] - inner[1] : inner[1] - inner[0]) : 0;
	return Math.max(0, spec.partial ? Math.min(bound, spec.partial.length) : bound);
}

/** Two items that would produce the same response part are the same item. */
function itemKey(item: Item): string {
	return item.kind === "section" ? `section ${item.alias ?? item.label} ${item.origin} ${item.spec.partial?.length}` : item.kind;
}

type Row = { msn: number; uid: number; id: string };

/**
 * One FETCH response line per message, written as soon as it is built so a large fetch holds one message at a
 * time. The line is sent in pieces: the text between literals is one write, each literal is written from the
 * buffer it was read into. `byteBudget` bounds what the sections of the whole command may add up to.
 * With `markSeen`, each unread message is shown as read and is marked read once its response has been written;
 * a message that is skipped, or that comes after the budget stopped the command, stays unread.
 * With `sent`, the mod-sequence each message's response was built from is recorded there, for `noteOwn`.
 */
async function respond(c: ImapConnection, rows: Row[], items: Item[], uidMode: boolean, byteBudget = Infinity, markSeen = false, sent?: Map<number, number>): Promise<void> {
	const selected = c.selected!;
	const withUid = uidMode && !items.some((item) => item.kind === "uid") ? [{ kind: "uid" as const }, ...items] : items;
	const needsIndex = withUid.some((item) => ["size", "envelope", "bodystructure", "body", "section"].includes(item.kind));
	const sections = withUid.filter((item): item is Item & { kind: "section" } => item.kind === "section");
	let charged = 0;
	const hasFlags = withUid.some((item) => item.kind === "flags");
	const needsModseq = withUid.some((item) => item.kind === "modseq");
	const pair = (name: string, value: unknown) => c.compile({ tag: "*", command: "X", attributes: [atom(name), value as never] }).slice("* X ".length);
	for (let at = 0; at < rows.length; at += 90) {
		const slice = rows.slice(at, at + 90);
		// The mod-sequence is read before the flags: a change in between then shows up as a newer number at the next refresh,
		// where the other order would pair old flags with a number that already counts the change.
		const modseqs = needsModseq || sent ? await modseqsOf(c.env, selected.mailboxId, selected.view.folderKey, slice.map((row) => row.uid), selected.view.userId) : null;
		const found = await loadMessageRows(c.env, selected.mailboxId, c.identity!.userId, slice.map((row) => row.id));
		const delivered: Row[] = [];
		try {
			for (const row of slice) {
				const stored: MessageFlagsRow | undefined = found.get(row.id);
				if (!stored) continue;
				const marks = markSeen && !stored.read;
				const message = marks ? { ...stored, read: true } : stored;
				const index = needsIndex ? await indexOf(c, row.id) : null;
				if (needsIndex && index === null) continue;
				const unindexable = index === UNINDEXABLE;
				if (sections.length && !unindexable) {
					charged += sections.reduce((total, item) => total + sectionBound(index!, item.spec), 0);
					if (charged > byteBudget) throw no("The fetch is too large; fetch fewer messages at once", "LIMIT");
				}
				let pending = `* ${row.msn} FETCH (`;
				let first = true;
				const add = (text: string) => {
					pending += first ? text : ` ${text}`;
					first = false;
				};
				for (const item of withUid) {
					switch (item.kind) {
						case "uid": add(pair("UID", row.uid)); break;
						case "modseq": {
							const value = modseqs!.get(row.uid);
							if (value !== undefined) add(pair("MODSEQ", [raw(String(value))]));
							break;
						}
						case "flags": add(pair("FLAGS", flagList(flagsOf(message)))); break;
						case "internaldate": add(pair("INTERNALDATE", internalDate(message.createdAt))); break;
						case "size": add(pair("RFC822.SIZE", index!.size)); break;
						case "envelope": add(pair("ENVELOPE", index!.envelope)); break;
						case "bodystructure": add(pair("BODYSTRUCTURE", index!.bodystructure)); break;
						case "body": add(pair("BODY", unindexable ? index!.bodystructure : withoutExtensions(index!.bodystructure as unknown[]))); break;
						case "section": {
							const data = await section(c, row.id, item.spec, unindexable);
							const name = item.alias ?? `BODY[${item.label}]${item.origin !== null ? `<${item.origin}>` : ""}`;
							if (data === null) add(`${name} NIL`);
							else {
								add(`${name} {${data.length}}\r\n`);
								await c.write(Buffer.from(pending, "latin1"));
								await c.write(data);
								pending = "";
							}
						}
					}
				}
				if (marks && !hasFlags) add(pair("FLAGS", flagList(flagsOf(message))));
				await c.write(Buffer.from(`${pending})\r\n`, "latin1"));
				const version = modseqs?.get(row.uid);
				if (sent && version !== undefined) sent.set(row.uid, version);
				if (marks) delivered.push(row);
			}
		} finally {
			if (delivered.length) await markDelivered(c, delivered);
		}
	}
}

type FetchModifiers = { changedSince: number | null; vanished: boolean };

/** `(CHANGEDSINCE n [VANISHED])` after the items (RFC 7162 sections 3.1.4 and 3.2.6). */
function parseModifiers(c: ImapConnection, arg: Arg, uidMode: boolean): FetchModifiers {
	const result: FetchModifiers = { changedSince: null, vanished: false };
	if (arg === undefined) return result;
	if (!isList(arg)) throw bad("FETCH modifiers are a list");
	for (let at = 0; at < arg.length; at += 1) {
		const word = text(arg[at])?.toUpperCase();
		if (word === "CHANGEDSINCE") {
			const value = parseModseq(text(arg[++at]) ?? "");
			if (value === null) throw bad("CHANGEDSINCE takes a mod-sequence");
			result.changedSince = value;
		} else if (word === "VANISHED") result.vanished = true;
		else throw bad("A FETCH modifier is not supported");
	}
	if (result.vanished && (result.changedSince === null || !uidMode || !c.qresync)) throw bad("VANISHED needs UID FETCH with CHANGEDSINCE, and QRESYNC enabled");
	if (result.changedSince !== null) c.enableCondstore();
	return result;
}

export async function runFetch(c: ImapConnection, command: ParsedCommand, uidMode: boolean): Promise<Completion> {
	const [setArg, itemsArg, modifiersArg, ...extra] = args(command);
	const ranges = parseSequenceSet(text(setArg) ?? "");
	if (!ranges || itemsArg === undefined || extra.length) throw bad("FETCH takes a message set and the items to fetch");
	const requested = isList(itemsArg) ? itemsArg : [itemsArg];
	if (requested.length > MAX_ITEMS) throw bad("Too many FETCH items");
	const seen = new Set<string>();
	const parsed = requested.flatMap(parseItem);
	// Two spellings of one item (BODY[1] and BODY.PEEK[1]) are sent once; the fetch marks the message read if either was not a peek.
	const marksSeen = parsed.some((item) => item.kind === "section" && !item.peek);
	const items = parsed.filter((item) => !seen.has(itemKey(item)) && seen.add(itemKey(item)));
	if (!items.length) throw bad("FETCH needs at least one item");
	const modifiers = parseModifiers(c, modifiersArg, uidMode);
	// MODSEQ is part of the answer to CHANGEDSINCE, asked for or not, and asking for it turns CONDSTORE on.
	if (modifiers.changedSince !== null && !items.some((item) => item.kind === "modseq")) items.push({ kind: "modseq" });
	if (items.some((item) => item.kind === "modseq")) c.enableCondstore();
	const view = c.selected!.view;
	const numbers = uidMode ? selectByUid(ranges, view.uids) : selectByNumber(ranges, view.exists);
	let rows = numbers.map((msn) => ({ msn, uid: view.uids[msn - 1], id: view.messageIds[msn - 1] }));
	if (modifiers.changedSince !== null) {
		if (modifiers.vanished) await c.sendVanished(await vanishedSince(c.env, view, modifiers.changedSince, resolveRanges(ranges, Math.max(view.uidNext - 1, 0))), true);
		const changed = await changedSince(c.env, view.mailboxId, view.folderKey, modifiers.changedSince, view.userId);
		rows = rows.filter((row) => changed.has(row.uid));
	}
	// A body section fetched without PEEK marks the message read (RFC 3501 6.4.5), in a read-write session only,
	// and the response carries the FLAGS the fetch changed, as the RFC requires.
	await respond(c, rows, items, uidMode, c.fetchByteBudget, !c.selected!.readOnly && marksSeen && (await mayMark(c)));
}

/** Whether this login (its app password and its permission) still allows changing the selected mailbox; a fetch that cannot mark messages read still works. */
async function mayMark(c: ImapConnection): Promise<boolean> {
	try {
		if (!(await c.checkCredentials(true))) return false;
		await c.requireMailboxWritable(c.selected!.mailboxId);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sets `\Seen` on messages whose response has been written, then tells the client what the messages are now: the response
 * carried the flags as they would be, this carries them as they are, with the new mod-sequence once CONDSTORE is on
 * (RFC 7162 section 3.2.4). A fetch must not fail because the flag could not be set; the mail simply stays unread.
 */
async function markDelivered(c: ImapConnection, rows: Row[]): Promise<void> {
	const selected = c.selected!;
	try {
		await storeFlags(c.env, c.identity!, selected.mailboxId, selected.view.folderKey, rows.map((row) => row.id), "add", parseFlagWords(["\\Seen"]));
	} catch (error) {
		console.warn("IMAP could not set \\Seen on fetch", error);
		return;
	}
	const sent = new Map<number, number>();
	await sendFlags(c, rows.map(({ msn, uid }) => ({ msn, uid })), true, sent);
	selected.view.noteOwn(sent);
}

/** Unsolicited `FETCH (UID n FLAGS (...))` for messages whose flags changed; `sent` collects the mod-sequences that went out with them. */
export async function sendFlags(c: ImapConnection, flagged: Array<{ msn: number; uid: number }>, withFlags = true, sent?: Map<number, number>): Promise<void> {
	const view = c.selected!.view;
	// Once CONDSTORE is on, a flag update carries the message's mod-sequence too.
	const items: Item[] = [...(withFlags ? [{ kind: "flags" as const }] : []), { kind: "uid" }, ...(c.condstore ? [{ kind: "modseq" as const }] : [])];
	await respond(c, flagged.map(({ msn, uid }) => ({ msn, uid, id: view.messageIds[msn - 1] })), items, false, Infinity, false, sent);
}

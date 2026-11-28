import { and, count as count_, eq } from "drizzle-orm";
import type { ParsedCommand } from "imap-handler";
import { getDb } from "@/db";
import { imapUids, messages } from "@/db/schema";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import { bad, no } from "@/lib/imap/errors";
import { decodeFolderName, encodeFolderName } from "@/lib/imap/folders";
import { SHARED_PREFIX, findFolder, type Namespace, type NamespaceFolder } from "@/lib/imap/namespace";
import { changedSince, parseModseq, vanishedSince } from "@/lib/imap/condstore";
import { parseSequenceSet, resolveRanges, type SetRange } from "@/lib/imap/sets";
import { ensureFolderState, syncMailbox } from "@/lib/imap/sync";
import { FolderView } from "@/lib/imap/view";
import type { Completion, ImapConnection } from "../connection";
import { args, isList, text, type Arg } from "./args";
import { sendFlags } from "./fetch";

const FLAGS = "\\Answered \\Flagged \\Deleted \\Seen \\Draft $Forwarded";
const PERMANENT_FLAGS = "\\Answered \\Flagged \\Deleted \\Seen $Forwarded \\*";
/** Longest LIST pattern and most wildcards in one. */
const MAX_PATTERN = 256;
const MAX_WILDCARDS = 8;
const MAX_PATTERNS = 16;
const MAX_STATUS_LINES = 100;

/** The mailbox name a client sent, as UTF-8. Names are modified UTF-7 here; anything else does not name a mailbox. */
function folderName(arg: Arg): string {
	const raw = text(arg);
	const decoded = raw === null ? null : decodeFolderName(raw);
	if (decoded === null) throw no("Mailbox does not exist", "NONEXISTENT");
	return decoded;
}

export function runNamespace(c: ImapConnection): Completion {
	c.untagged(`NAMESPACE (("" "/")) NIL (("${SHARED_PREFIX}/" "/"))`);
}

// ---- SELECT / EXAMINE ----

/**
 * EXAMINE, and SELECT of a mailbox this login may only read, answer [READ-ONLY] with no
 * permanent flags, so a client offers no changes; otherwise the session is read-write. The folder is found through
 * the access layer, the app password is checked again, and the folder's change feed is
 * watched before its state is read, so a change in between is not missed.
 */
export async function runSelect(c: ImapConnection, command: ParsedCommand, examine: boolean): Promise<Completion> {
	const [nameArg, paramsArg, ...rest] = args(command);
	if (!nameArg || rest.length) throw bad(`${examine ? "EXAMINE" : "SELECT"} takes a mailbox name`);
	const params = parseSelectParams(c, paramsArg);
	const hadFolder = c.selected !== null;
	c.deselect();
	// A server that offers CONDSTORE or QRESYNC announces the folder that is left as closed (RFC 7162 section 3.2.11); both are always offered.
	if (hadFolder) c.untagged("OK [CLOSED] Previous mailbox is now closed");
	const name = folderName(nameArg);
	if (!(await c.checkCredentials(true))) throw no("Credentials revoked");
	const namespace = await c.namespace();
	const folder = findFolder(namespace, name);
	if (!folder || !folder.key || !folder.mailboxId) throw no("Mailbox does not exist", "NONEXISTENT");
	const mailboxId = folder.mailboxId;
	const unwatch = await c.notifier.watch(mailboxId, c.identity!.userId, () => c.changed());
	let view: FolderView;
	try {
		view = await FolderView.open(c.env, mailboxId, folder.key, c.identity!.userId);
	} catch (error) {
		unwatch();
		throw error;
	}
	// The client may have gone while the folder was being read; nobody would unwatch it then.
	if (c.isClosed) {
		unwatch();
		throw no("The connection is closed");
	}
	const readOnly = examine || folder.permission === "read_only";
	c.select({ view, mailboxId, name: folder.name, readOnly, unwatch });
	c.untagged(`FLAGS (${FLAGS})`);
	c.untagged(`${view.exists} EXISTS`);
	c.untagged("0 RECENT");
	c.untagged(`OK [UIDVALIDITY ${view.uidvalidity}] UIDs valid`);
	c.untagged(`OK [UIDNEXT ${view.uidNext}] Predicted next UID`);
	c.untagged(readOnly ? "OK [PERMANENTFLAGS ()] No permanent flags" : `OK [PERMANENTFLAGS (${PERMANENT_FLAGS})] Limited`);
	c.untagged(`OK [HIGHESTMODSEQ ${view.highest}] Highest`);
	if (params.qresync && params.qresync.uidvalidity === view.uidvalidity) await resync(c, view, params.qresync);
	return { code: readOnly ? "READ-ONLY" : "READ-WRITE", text: `${examine ? "EXAMINE" : "SELECT"} completed` };
}

type Resync = { uidvalidity: number; modseq: number; known: SetRange[] | null };

const DIGITS = /^\d{1,10}$/;

/** `(CONDSTORE)` and `(QRESYNC (uidvalidity modseq [known-uids [(seq-match-data)]]))` after the mailbox name (RFC 7162 sections 3.1.8 and 3.2.5). */
function parseSelectParams(c: ImapConnection, arg: Arg): { qresync: Resync | null } {
	if (arg === undefined) return { qresync: null };
	if (!isList(arg)) throw bad("SELECT parameters are a list");
	let qresync: Resync | null = null;
	let condstore = false;
	for (let at = 0; at < arg.length; at += 1) {
		const word = text(arg[at])?.toUpperCase();
		if (word === "CONDSTORE") condstore = true;
		else if (word === "QRESYNC") {
			const inner = arg[++at];
			if (!c.qresync) throw bad("QRESYNC is not enabled");
			if (!isList(inner) || inner.length < 2 || inner.length > 4) throw bad("QRESYNC takes a UIDVALIDITY, a mod-sequence and optional known UIDs");
			const [validity, modseqArg, known, match] = inner;
			const uidvalidity = text(validity);
			const modseq = parseModseq(text(modseqArg) ?? "");
			if (uidvalidity === null || !DIGITS.test(uidvalidity) || modseq === null) throw bad("The QRESYNC values are not valid");
			let knownRanges: SetRange[] | null = null;
			if (known !== undefined) {
				knownRanges = parseSequenceSet(text(known) ?? "");
				if (!knownRanges) throw bad("The known UIDs are not a valid set");
			}
			// The message number matching data only lets a server say less; this server answers in full, so it is checked and not used.
			if (match !== undefined && (!isList(match) || match.length !== 2 || match.some((part) => !parseSequenceSet(text(part) ?? "")))) throw bad("The sequence match data is not valid");
			qresync = { uidvalidity: Number(uidvalidity), modseq, known: knownRanges };
		} else throw bad("A SELECT parameter is not supported");
	}
	if (condstore || qresync) c.condstore = true;
	return { qresync };
}

/**
 * The answer to a QRESYNC select: what vanished since the client's mod-sequence, and a FETCH (UID, FLAGS and
 * MODSEQ) for every message that is new or changed since, so the client catches up without a rescan.
 * A UIDVALIDITY that is not the folder's is not an error: the select goes on as a plain one and the client sees the new value.
 */
async function resync(c: ImapConnection, view: FolderView, request: Resync): Promise<void> {
	const within = request.known ? resolveRanges(request.known, Math.max(view.uidNext - 1, 0)) : null;
	await c.sendVanished(await vanishedSince(c.env, view, request.modseq, within), true);
	const changed = await changedSince(c.env, view.mailboxId, view.folderKey, request.modseq, view.userId);
	const flagged = view.uids.flatMap((uid, index) => (changed.has(uid) ? [{ msn: index + 1, uid }] : []));
	if (flagged.length) await sendFlags(c, flagged);
}

// ---- STATUS ----

type StatusItem = "MESSAGES" | "RECENT" | "UIDNEXT" | "UIDVALIDITY" | "UNSEEN" | "HIGHESTMODSEQ";
const STATUS_ITEMS: StatusItem[] = ["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN", "HIGHESTMODSEQ"];

async function statusLine(c: ImapConnection, folder: NamespaceFolder, items: StatusItem[]): Promise<string> {
	const mailboxId = folder.mailboxId!;
	await syncMailbox(c.env, mailboxId);
	await ensureFolderState(c.env, mailboxId, folder.key!);
	const [state] = (await c.env.DB.prepare("SELECT uidvalidity, uid_next, highest_modseq FROM imap_folder_state WHERE id = ?").bind(`${mailboxId}:${folder.key}`).all<{ uidvalidity: number; uid_next: number; highest_modseq: number }>()).results;
	// Counts cover the messages the user may see: another user's draft is not counted.
	const count = async (unseenOnly: boolean) => {
		const [row] = await getDb(c.env)
			.select({ n: count_() })
			.from(imapUids)
			.innerJoin(messages, and(eq(messages.id, imapUids.messageId), eq(messages.mailboxId, imapUids.mailboxId)))
			.where(and(eq(imapUids.mailboxId, mailboxId), eq(imapUids.folderKey, folder.key!), draftsVisibleTo(c.identity!.userId), ...(unseenOnly ? [eq(messages.read, false)] : [])));
		return Number(row?.n ?? 0);
	};
	const parts: string[] = [];
	for (const item of items) {
		if (item === "MESSAGES") parts.push(`MESSAGES ${await count(false)}`);
		else if (item === "RECENT") parts.push("RECENT 0");
		else if (item === "UIDNEXT") parts.push(`UIDNEXT ${Number(state.uid_next)}`);
		else if (item === "UIDVALIDITY") parts.push(`UIDVALIDITY ${Number(state.uidvalidity)}`);
		else if (item === "HIGHESTMODSEQ") {
			// Asking for it turns CONDSTORE on (RFC 7162 section 3.1.2).
			c.enableCondstore();
			parts.push(`HIGHESTMODSEQ ${Math.max(Number(state.highest_modseq), 1)}`);
		}
		else parts.push(`UNSEEN ${await count(true)}`);
	}
	return `STATUS ${quoteName(c, folder.name)} (${parts.join(" ")})`;
}

/** A folder name as it goes on the wire: modified UTF-7, quoted or sent as a literal as the compiler decides. */
function quoteName(c: ImapConnection, name: string): string {
	return c.compile({ tag: "*", command: "X", attributes: [encodeFolderName(name)] }).slice("* X ".length);
}

export async function runStatus(c: ImapConnection, command: ParsedCommand): Promise<Completion> {
	const [nameArg, itemsArg, ...rest] = args(command);
	if (!nameArg || !isList(itemsArg) || rest.length) throw bad("STATUS takes a mailbox name and a list of items");
	const items: StatusItem[] = [];
	for (const item of itemsArg) {
		const word = text(item)?.toUpperCase();
		if (!word || !(STATUS_ITEMS as string[]).includes(word)) throw bad("A STATUS item is not supported");
		if (!items.includes(word as StatusItem)) items.push(word as StatusItem);
	}
	if (!items.length) throw bad("STATUS needs at least one item");
	const name = folderName(nameArg);
	const namespace = await c.namespace();
	const folder = findFolder(namespace, name);
	if (!folder || !folder.key || !folder.mailboxId) throw no("Mailbox does not exist", "NONEXISTENT");
	const line = await statusLine(c, folder, items);
	c.untagged(line);
}

// ---- LIST / LSUB ----

/** Wildcard match on /-separated names, computed row by row over the name. */
export function matchesPattern(pattern: string, name: string): boolean {
	let row = new Array<boolean>(name.length + 1).fill(false);
	row[0] = true;
	for (let p = 0; p < pattern.length; p += 1) {
		const char = pattern[p];
		const next = new Array<boolean>(name.length + 1).fill(false);
		next[0] = row[0] && (char === "*" || char === "%");
		for (let n = 1; n <= name.length; n += 1) {
			if (char === "*") next[n] = next[n - 1] || row[n];
			else if (char === "%") next[n] = row[n] || (next[n - 1] && name[n - 1] !== "/");
			else next[n] = row[n - 1] && name[n - 1] === char;
		}
		row = next;
	}
	return row[name.length];
}

function patternList(arg: Arg): string[] {
	const patterns = isList(arg) ? arg.map(text) : [text(arg)];
	if (!patterns.length || patterns.some((pattern) => pattern === null)) throw bad("LIST takes a pattern");
	if (patterns.length > MAX_PATTERNS) throw bad("Too many LIST patterns");
	return patterns as string[];
}

/**
 * LIST and LSUB (RFC 3501, with LIST-EXTENDED selection and return options and
 * LIST-STATUS). Every folder is subscribed, so LSUB lists what LIST does. The names
 * come from the access layer's namespace: nothing else can be matched.
 */
export async function runList(c: ImapConnection, command: ParsedCommand, verb: "LIST" | "LSUB"): Promise<Completion> {
	let rest = args(command);
	let selection: string[] = [];
	if (verb === "LIST" && isList(rest[0])) {
		selection = (rest[0] as Arg[]).map((option) => text(option)?.toUpperCase() ?? "");
		if (selection.some((option) => !["SUBSCRIBED", "REMOTE", "SPECIAL-USE", "RECURSIVEMATCH"].includes(option))) throw bad("A LIST selection option is not supported");
		rest = rest.slice(1);
	}
	const reference = text(rest[0]);
	if (reference === null || rest.length < 2) throw bad("LIST takes a reference name and a pattern");
	const patterns = patternList(rest[1]);
	const returned: string[] = [];
	let statusItems: StatusItem[] = [];
	if (rest.length > 2) {
		if (verb !== "LIST" || text(rest[2])?.toUpperCase() !== "RETURN" || !isList(rest[3]) || rest.length > 4) throw bad("LIST takes RETURN options after the pattern");
		const options = rest[3] as Arg[];
		for (let at = 0; at < options.length; at += 1) {
			const option = text(options[at])?.toUpperCase() ?? "";
			if (option === "STATUS") {
				const wanted = options[++at];
				if (!isList(wanted)) throw bad("RETURN (STATUS ...) takes a list of items");
				statusItems = (wanted as Arg[]).map((item) => text(item)?.toUpperCase() as StatusItem);
				if (!statusItems.length || statusItems.some((item) => !(STATUS_ITEMS as string[]).includes(item))) throw bad("A STATUS item is not supported");
			} else if (["CHILDREN", "SPECIAL-USE", "SUBSCRIBED"].includes(option)) returned.push(option);
			else throw bad("A LIST return option is not supported");
		}
	}
	for (const pattern of patterns) {
		if (pattern.length > MAX_PATTERN || [...pattern].filter((char) => char === "*" || char === "%").length > MAX_WILDCARDS) throw bad("The LIST pattern is too long or has too many wildcards");
	}
	if (reference.length > MAX_PATTERN) throw bad("The reference name is too long");
	const namespace = await c.namespace();
	const subscribedAttribute = verb === "LSUB" || selection.includes("SUBSCRIBED") || returned.includes("SUBSCRIBED");
	let statusLines = 0;
	const emitted = new Set<string>();
	for (const raw of patterns) {
		const combined = reference + raw;
		const unfolded = combined === "" ? "" : decodeFolderName(combined);
		if (unfolded === null) continue;
		// INBOX is the one name that is not case-sensitive.
		const decoded = unfolded.slice(0, 5).toUpperCase() === "INBOX" ? `INBOX${unfolded.slice(5)}` : unfolded;
		if (decoded === "") {
			// The delimiter query: no name, just the hierarchy delimiter.
			if (!emitted.has("")) c.untagged(`${verb} (\\Noselect) "/" ""`);
			emitted.add("");
			continue;
		}
		for (const folder of namespace.folders) {
			if (emitted.has(folder.name) || !matchesPattern(decoded, folder.name)) continue;
			if (selection.includes("SPECIAL-USE") && !folder.attributes.some((attribute) => !attribute.startsWith("\\Has") && attribute !== "\\Noselect")) continue;
			emitted.add(folder.name);
			const attributes = [...folder.attributes, ...(subscribedAttribute && !folder.attributes.includes("\\Noselect") ? ["\\Subscribed"] : [])];
			c.untagged(`${verb} (${attributes.join(" ")}) "/" ${quoteName(c, folder.name)}`);
			if (statusItems.length && folder.key && folder.mailboxId && statusLines < MAX_STATUS_LINES) {
				statusLines += 1;
				try {
					c.untagged(await statusLine(c, folder, statusItems));
				} catch (error) {
					console.warn("IMAP LIST STATUS failed", error);
				}
			}
		}
	}
	return;
}

export type { Namespace };

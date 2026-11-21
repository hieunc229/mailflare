import type { ParsedCommand } from "imap-handler";
import { bad, no } from "@/lib/imap/errors";
import { decodeFolderName, encodeFolderName } from "@/lib/imap/folders";
import { SHARED_PREFIX, findFolder, type Namespace, type NamespaceFolder } from "@/lib/imap/namespace";
import { ensureFolderState, syncMailbox } from "@/lib/imap/sync";
import { FolderView } from "@/lib/imap/view";
import type { Completion, ImapConnection } from "../connection";
import { args, isList, text, type Arg } from "./args";

const FLAGS = "\\Answered \\Flagged \\Deleted \\Seen \\Draft";
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
 * Everything is read-only in this version (writes are a later step), so both commands
 * answer [READ-ONLY]; a client then offers no flag changes. The folder is found through
 * the access layer, the app password is checked again, and the folder's change feed is
 * watched before its state is read, so a change in between is not missed.
 */
export async function runSelect(c: ImapConnection, command: ParsedCommand, examine: boolean): Promise<Completion> {
	const [nameArg, ...rest] = args(command);
	if (!nameArg || rest.length) throw bad(`${examine ? "EXAMINE" : "SELECT"} takes a mailbox name`);
	c.deselect();
	const name = folderName(nameArg);
	if (!(await c.checkCredentials(true))) throw no("Credentials revoked");
	const namespace = await c.namespace();
	const folder = findFolder(namespace, name);
	if (!folder || !folder.key || !folder.mailboxId) throw no("Mailbox does not exist", "NONEXISTENT");
	const mailboxId = folder.mailboxId;
	const unwatch = await c.notifier.watch(mailboxId, c.identity!.userId, () => c.changed());
	let view: FolderView;
	try {
		view = await FolderView.open(c.env, mailboxId, folder.key);
	} catch (error) {
		unwatch();
		throw error;
	}
	// The client may have gone while the folder was being read; nobody would unwatch it then.
	if (c.isClosed) {
		unwatch();
		throw no("The connection is closed");
	}
	c.select({ view, mailboxId, name: folder.name, readOnly: true, unwatch });
	c.untagged(`FLAGS (${FLAGS})`);
	c.untagged(`${view.exists} EXISTS`);
	c.untagged("0 RECENT");
	c.untagged(`OK [UIDVALIDITY ${view.uidvalidity}] UIDs valid`);
	c.untagged(`OK [UIDNEXT ${view.uidNext}] Predicted next UID`);
	c.untagged("OK [PERMANENTFLAGS ()] No permanent flags");
	return { code: "READ-ONLY", text: `${examine ? "EXAMINE" : "SELECT"} completed` };
}

// ---- STATUS ----

type StatusItem = "MESSAGES" | "RECENT" | "UIDNEXT" | "UIDVALIDITY" | "UNSEEN";
const STATUS_ITEMS: StatusItem[] = ["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN"];

async function statusLine(c: ImapConnection, folder: NamespaceFolder, items: StatusItem[]): Promise<string> {
	const mailboxId = folder.mailboxId!;
	await syncMailbox(c.env, mailboxId);
	await ensureFolderState(c.env, mailboxId, folder.key!);
	const [state] = (await c.env.DB.prepare("SELECT uidvalidity, uid_next FROM imap_folder_state WHERE id = ?").bind(`${mailboxId}:${folder.key}`).all<{ uidvalidity: number; uid_next: number }>()).results;
	const count = async (unseenOnly: boolean) => {
		const query = unseenOnly
			? "SELECT count(*) AS n FROM imap_uids u INNER JOIN messages m ON m.id = u.message_id AND m.mailbox_id = u.mailbox_id WHERE u.mailbox_id = ? AND u.folder_key = ? AND m.read = ?"
			: "SELECT count(*) AS n FROM imap_uids WHERE mailbox_id = ? AND folder_key = ?";
		const bindings = unseenOnly ? [mailboxId, folder.key, false] : [mailboxId, folder.key];
		const [row] = (await c.env.DB.prepare(query).bind(...bindings).all<{ n: number }>()).results;
		return Number(row?.n ?? 0);
	};
	const parts: string[] = [];
	for (const item of items) {
		if (item === "MESSAGES") parts.push(`MESSAGES ${await count(false)}`);
		else if (item === "RECENT") parts.push("RECENT 0");
		else if (item === "UIDNEXT") parts.push(`UIDNEXT ${Number(state.uid_next)}`);
		else if (item === "UIDVALIDITY") parts.push(`UIDVALIDITY ${Number(state.uidvalidity)}`);
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

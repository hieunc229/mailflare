import type { ParsedCommand } from "imap-handler";
import { bad, no } from "@/lib/imap/errors";
import { MAX_STORE_MESSAGES, parseFlagWords, storeFlags, type FlagMode, type StoreGuard } from "@/lib/imap/flags";
import { modseqsOf, parseModseq } from "@/lib/imap/condstore";
import { parseSequenceSet, compactSet, selectByNumber, selectByUid } from "@/lib/imap/sets";
import { syncMailbox, syncedChangeSeq } from "@/lib/imap/sync";
import type { Completion, ImapConnection } from "../connection";
import { args, isList, text } from "./args";
import { sendFlags } from "./fetch";

const ITEM = /^([+-]?)FLAGS(\.SILENT)?$/i;

/** The flag words of a STORE or APPEND: a parenthesised list, or (STORE only) one bare flag. */
export function flagWords(arg: ReturnType<typeof args>[number]): string[] {
	const list = isList(arg) ? arg : [arg];
	const words = list.map(text);
	if (words.some((word) => word === null)) throw bad("A flag is not valid");
	return words as string[];
}

/**
 * STORE and UID STORE: `FLAGS`, `+FLAGS`, `-FLAGS`, each with `.SILENT`. The messages are the
 * selected folder's, by number or UID as the view had them when the command arrived. The
 * answer lists the flags of every message named (unless silent); the view is told these
 * messages are already known, so the next update does not repeat them.
 */
export async function runStore(c: ImapConnection, command: ParsedCommand, uidMode: boolean): Promise<Completion> {
	const [setArg, ...tail] = args(command);
	// `(UNCHANGEDSINCE n)` may stand between the set and the item (RFC 7162 section 3.1.3).
	let unchangedSince: number | null = null;
	let rest = tail;
	if (isList(rest[0])) {
		const modifier = rest[0];
		const value = modifier.length === 2 && text(modifier[0])?.toUpperCase() === "UNCHANGEDSINCE" ? parseModseq(text(modifier[1]) ?? "") : null;
		if (value === null) throw bad("STORE takes the modifier UNCHANGEDSINCE and a mod-sequence");
		unchangedSince = value;
		rest = rest.slice(1);
	}
	const [itemArg, flagsArg, ...extra] = rest;
	const ranges = parseSequenceSet(text(setArg) ?? "");
	const item = ITEM.exec(text(itemArg) ?? "");
	if (!ranges || !item || flagsArg === undefined || extra.length) throw bad("STORE takes a message set, a flags item and a list of flags");
	const mode: FlagMode = item[1] === "+" ? "add" : item[1] === "-" ? "remove" : "replace";
	const parsed = parseFlagWords(flagWords(flagsArg));
	await c.requireWritable();
	const view = c.selected!.view;
	const numbers = uidMode ? selectByUid(ranges, view.uids) : selectByNumber(ranges, view.exists);
	if (numbers.length > MAX_STORE_MESSAGES) throw no("Too many messages in one STORE; store fewer at once", "LIMIT");
	const rows = numbers.map((msn) => ({ msn, uid: view.uids[msn - 1], id: view.messageIds[msn - 1] }));
	// Messages changed since the client's mod-sequence are left alone and named in the answer. The state is synced first, so a change another writer made
	// is seen, and the change-log position of that sync is kept: every write then checks, in its own statement, that the message has no later entry in
	// the log, so a change that lands after this check (also while an earlier group of a large STORE is written) is not overwritten and is named too.
	let modified: typeof rows = [];
	let todo = rows;
	let guard: StoreGuard | undefined;
	if (unchangedSince !== null) {
		c.enableCondstore();
		await syncMailbox(c.env, c.selected!.mailboxId);
		guard = { jmapSeq: (await syncedChangeSeq(c.env, c.selected!.mailboxId)) ?? 0, unwritten: new Set() };
		const current = await modseqsOf(c.env, c.selected!.mailboxId, view.folderKey, rows.map((row) => row.uid));
		modified = rows.filter((row) => (current.get(row.uid) ?? 0) > unchangedSince!);
		todo = rows.filter((row) => !modified.includes(row));
	}
	const found = new Set(await storeFlags(c.env, c.identity!, c.selected!.mailboxId, view.folderKey, todo.map((row) => row.id), mode, parsed, guard));
	if (guard?.unwritten.size) modified = rows.filter((row) => modified.includes(row) || guard!.unwritten.has(row.id));
	const done = todo.filter((row) => found.has(row.id) && !guard?.unwritten.has(row.id));
	// With UNCHANGEDSINCE the new mod-sequence is always reported, also for .SILENT (without the flags).
	const sent = new Map<number, number>();
	if (!item[2] || unchangedSince !== null) await sendFlags(c, done.map(({ msn, uid }) => ({ msn, uid })), !item[2], sent);
	// A silent STORE sends nothing: the client is taken to hold the versions as they are right after its own write.
	else for (const [uid, value] of await modseqsOf(c.env, c.selected!.mailboxId, view.folderKey, done.map((row) => row.uid))) sent.set(uid, value);
	view.noteOwn(sent);
	if (modified.length) return { code: `MODIFIED ${compactSet(modified.map((row) => (uidMode ? row.uid : row.msn)))}`, text: "Conditional STORE failed" };
}

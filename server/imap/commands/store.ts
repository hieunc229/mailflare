import type { ParsedCommand } from "imap-handler";
import { bad, no } from "@/lib/imap/errors";
import { MAX_STORE_MESSAGES, parseFlagWords, storeFlags, type FlagMode } from "@/lib/imap/flags";
import { parseSequenceSet, selectByNumber, selectByUid } from "@/lib/imap/sets";
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
	const [setArg, itemArg, flagsArg, ...extra] = args(command);
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
	const found = new Set(await storeFlags(c.env, c.identity!, c.selected!.mailboxId, view.folderKey, rows.map((row) => row.id), mode, parsed));
	const done = rows.filter((row) => found.has(row.id));
	if (!item[2]) await sendFlags(c, done.map(({ msn, uid }) => ({ msn, uid })));
	await view.noteOwn(done.map((row) => row.uid));
}

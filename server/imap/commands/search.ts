import type { ParsedCommand } from "imap-handler";
import { bad, no } from "@/lib/imap/errors";
import { maxModseqOf } from "@/lib/imap/condstore";
import { SearchEvaluator, decoderFor, parseSearchCriteria, usesModseq } from "@/lib/imap/search";
import { compactSet } from "@/lib/imap/sets";
import type { Completion, ImapConnection } from "../connection";
import { args, isList, text } from "./args";

/** SEARCH and UID SEARCH, with ESEARCH `RETURN (MIN MAX ALL COUNT)`. */
export async function runSearch(c: ImapConnection, command: ParsedCommand, uidMode: boolean): Promise<Completion> {
	let rest = args(command);
	let returns: string[] | null = null;
	if (text(rest[0])?.toUpperCase() === "RETURN" && !isList(rest[0])) {
		if (!isList(rest[1])) throw bad("RETURN takes a list of options");
		returns = rest[1].map((option) => text(option)?.toUpperCase() ?? "");
		if (returns.some((option) => !["MIN", "MAX", "ALL", "COUNT"].includes(option))) throw bad("A SEARCH return option is not supported");
		if (!returns.length) returns = ["ALL"];
		rest = rest.slice(2);
	}
	let charset: string | null = null;
	if (text(rest[0])?.toUpperCase() === "CHARSET" && !isList(rest[0])) {
		charset = text(rest[1]);
		if (charset === null) throw bad("CHARSET takes a name");
		rest = rest.slice(2);
	}
	const decode = decoderFor(charset);
	if (!decode) throw no("The charset is not supported", "BADCHARSET (UTF-8 US-ASCII)");
	const criteria = parseSearchCriteria(rest as never, decode);
	const view = c.selected!.view;
	const uids = await new SearchEvaluator(c.env, view).run(criteria);
	const msnOfUid = new Map(view.uids.map((uid, index) => [uid, index + 1]));
	const numbers = uidMode ? uids : uids.map((uid) => msnOfUid.get(uid)!);
	// A search that names MODSEQ turns CONDSTORE on and reports the highest mod-sequence among the messages it found.
	let highest: number | null = null;
	if (usesModseq(criteria)) {
		c.enableCondstore();
		if (uids.length) highest = await maxModseqOf(c.env, view.mailboxId, view.folderKey, uids, view.userId);
	}
	if (returns === null) {
		c.untagged(`SEARCH${numbers.length ? ` ${numbers.join(" ")}` : ""}${highest !== null ? ` (MODSEQ ${highest})` : ""}`);
		return;
	}
	const parts: string[] = [];
	if (returns.includes("MIN") && numbers.length) parts.push(`MIN ${numbers[0]}`);
	if (returns.includes("MAX") && numbers.length) parts.push(`MAX ${numbers[numbers.length - 1]}`);
	if (returns.includes("COUNT")) parts.push(`COUNT ${numbers.length}`);
	if (returns.includes("ALL") && numbers.length) parts.push(`ALL ${compactSet(numbers)}`);
	if (highest !== null) parts.push(`MODSEQ ${highest}`);
	c.untagged(`ESEARCH (TAG "${command.tag}")${uidMode ? " UID" : ""}${parts.length ? ` ${parts.join(" ")}` : ""}`);
}

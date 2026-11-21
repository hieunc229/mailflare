import type { ParsedCommand } from "imap-handler";
import { appendMessage } from "@/lib/imap/append";
import { bad, no } from "@/lib/imap/errors";
import { MAX_KEYWORDS, parseFlagWords } from "@/lib/imap/flags";
import { decodeFolderName } from "@/lib/imap/folders";
import { addRefusal, findFolder, mayAddTo } from "@/lib/imap/namespace";
import type { Completion, ImapConnection } from "../connection";
import { args, isList, text } from "./args";
import { flagWords } from "./store";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_TIME = /^ ?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** `date-time` of RFC 3501 (`01-Jan-2024 10:00:00 +0100`) as a Date; null when it is not one. */
export function parseInternalDate(value: string): Date | null {
	const match = DATE_TIME.exec(value);
	if (!match) return null;
	const month = MONTHS.indexOf(match[2].toLowerCase());
	const [day, year, hour, minute, second, zoneHour, zoneMinute] = [match[1], match[3], match[4], match[5], match[6], match[8], match[9]].map(Number);
	if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60 || zoneHour > 23 || zoneMinute > 59) return null;
	const offset = (zoneHour * 60 + zoneMinute) * (match[7] === "-" ? -1 : 1);
	const date = new Date(Date.UTC(year, month, day, hour, minute, Math.min(second, 59)) - offset * 60_000);
	// A day that does not exist in the month (31 February) rolled over into the next one.
	return Number.isNaN(date.getTime()) || new Date(Date.UTC(year, month, day)).getUTCMonth() !== month ? null : date;
}

/**
 * APPEND mailbox [flags] [date-time] message. The message arrives as `body`, framed by the connection under the
 * APPEND size limit; the command text holds an empty string in its place. A folder name that does not exist is
 * NO [TRYCREATE]; what the login may add depends on the folder (`mayAddTo`). Answered with APPENDUID (UIDPLUS).
 */
export async function runAppend(c: ImapConnection, command: ParsedCommand, body: Buffer | undefined): Promise<Completion> {
	if (!body) throw bad("APPEND needs the message as a literal");
	const list = args(command);
	const [mailboxArg, ...rest] = list;
	const placeholder = rest.pop();
	if (text(placeholder) !== "" || !mailboxArg) throw bad("APPEND takes a mailbox name, optional flags and date, and a message");
	let flags: string[] = [];
	let internalDate: Date | null = null;
	if (isList(rest[0])) flags = flagWords(rest.shift());
	if (rest.length && !isList(rest[0])) {
		const given = text(rest.shift());
		internalDate = given === null ? null : parseInternalDate(given);
		if (!internalDate) throw bad("The date and time are not valid");
	}
	if (rest.length) throw bad("APPEND takes one message");
	const parsedFlags = parseFlagWords(flags);
	if (parsedFlags.keywords.length > MAX_KEYWORDS) throw no("A message may have at most 50 keywords", "LIMIT");
	const raw = text(mailboxArg);
	const name = raw === null ? null : decodeFolderName(raw);
	if (name === null) throw no("Mailbox does not exist", "TRYCREATE");
	const namespace = await c.namespace();
	const folder = findFolder(namespace, name);
	if (!folder || !folder.key || !folder.mailboxId) throw no("Mailbox does not exist", "TRYCREATE");
	const mailbox = namespace.mailboxes.find((entry) => entry.id === folder.mailboxId);
	if (!mailbox) throw no("Mailbox does not exist", "TRYCREATE");
	if (!mayAddTo(mailbox.permission, folder.key)) throw no(addRefusal(mailbox.permission), "NOPERM");
	const result = await appendMessage(c.env, c.identity!, { mailboxId: folder.mailboxId, key: folder.key, ownerUserId: mailbox.userId }, { raw: body, flags: parsedFlags, internalDate });
	// A message appended to the folder the session has open is announced before the answer.
	if (c.selected?.mailboxId === folder.mailboxId) c.dirty = true;
	return { code: `APPENDUID ${result.uidvalidity} ${result.uid}`, text: "APPEND completed" };
}

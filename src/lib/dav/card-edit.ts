import { isDavAddress } from "./address";

/**
 * Edits of a stored vCard made on the Mailflare side (spec 8.4): a new card, a new name, one address less. Every other
 * line is returned byte for byte (folds, line endings, groups, parameters), so what a phone stored and Mailflare does
 * not model (phone numbers, photos, custom properties) survives.
 */

/** One logical content line: `raw` is its physical lines with their terminators, `text` the unfolded content. */
type Entry = { raw: string; text: string };

function entriesOf(body: string): Entry[] {
	const entries: Entry[] = [];
	for (let start = 0; start < body.length; ) {
		let end = body.indexOf("\n", start);
		end = end < 0 ? body.length : end + 1;
		const physical = body.slice(start, end);
		const content = physical.endsWith("\r\n") ? physical.slice(0, -2) : physical.endsWith("\n") ? physical.slice(0, -1) : physical;
		start = end;
		const last = entries[entries.length - 1];
		if (last && (content[0] === " " || content[0] === "\t")) {
			last.raw += physical;
			last.text += content.slice(1);
		} else entries.push({ raw: physical, text: content });
	}
	return entries;
}

/** The terminator an entry ended with (none for a last line without one). */
const terminatorOf = (entry: Entry) => (entry.raw.endsWith("\r\n") ? "\r\n" : entry.raw.endsWith("\n") ? "\n" : "");

/** Where the value starts: the first colon outside double quotes (a parameter value may hold one). */
function colonOf(text: string): number {
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') quoted = !quoted;
		else if (text[i] === ":" && !quoted) return i;
	}
	return -1;
}

type Parts = { group: string; name: string; head: string; value: string };

/** A line's group (`item1.`), upper-cased property name, everything before the value, and the value; null when it is not a property. */
function partsOf(entry: Entry): Parts | null {
	const colon = colonOf(entry.text);
	if (colon < 1) return null;
	const head = entry.text.slice(0, colon);
	const token = head.split(";")[0];
	const dot = token.indexOf(".");
	return { group: dot < 0 ? "" : token.slice(0, dot + 1), name: token.slice(dot + 1).toUpperCase(), head, value: entry.text.slice(colon + 1) };
}

/** TEXT escaping (RFC 6350 section 3.4); a stray carriage return or control character could start a new line, so it goes. */
export function escapeText(value: string): string {
	return value
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,");
}

const unescape = (value: string) => value.replace(/\\([nN\\;,])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));

/** `N` for a display name: the last space splits the family name from the given names (spec 8.4). */
function structuredName(name: string): string {
	const space = name.lastIndexOf(" ");
	const [given, family] = space < 0 ? ["", name] : [name.slice(0, space).trim(), name.slice(space + 1)];
	return `${escapeText(family)};${escapeText(given)};;;`;
}

/** A content line cut into physical lines of at most 75 octets (RFC 6350 section 3.2); a UTF-8 character is never split. */
function fold(line: string, eol = "\r\n"): string {
	let out = "";
	let used = 0;
	for (const char of line) {
		const size = char.codePointAt(0)! < 0x80 ? 1 : char.codePointAt(0)! < 0x800 ? 2 : char.codePointAt(0)! < 0x10000 ? 3 : 4;
		if (used + size > 75) {
			out += `${eol} `;
			used = 1;
		}
		out += char;
		used += size;
	}
	return out;
}

/** A new 3.0 card for a contact created in Mailflare; a contact without a name is named after its address (FN is required). */
export function buildCard(input: { uid: string; name: string | null; email: string }): string {
	const name = input.name?.trim() || input.email;
	return ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Mailflare//Contacts//EN", `UID:${escapeText(input.uid)}`, `FN:${escapeText(name)}`, `N:${structuredName(name)}`, `EMAIL;TYPE=INTERNET:${input.email}`, "END:VCARD", ""].map((line) => fold(line)).join("\r\n");
}

/** Index of the closing `END:VCARD`, or -1. */
const endOf = (entries: Entry[]) => entries.findLastIndex((entry) => entry.text.trim().toUpperCase() === "END:VCARD");

/**
 * The card with FN and N set from a name. FN and N are rewritten, a missing one is added before END, and nothing else
 * changes. A card that already has that FN is returned as it was (no change-log row follows); text that is not a card too.
 */
export function renameCard(body: string, name: string): string {
	const wanted = name.trim();
	const entries = entriesOf(body);
	const end = endOf(entries);
	if (!wanted || end < 0 || entries[0]?.text.trim().toUpperCase() !== "BEGIN:VCARD") return body;
	const eol = terminatorOf(entries[0]) || "\r\n";
	const find = (property: string) => entries.findIndex((entry) => partsOf(entry)?.name === property);
	const fn = find("FN");
	if (fn >= 0 && unescape(partsOf(entries[fn])!.value).trim() === wanted) return body;

	const added: Entry[] = [];
	const set = (property: string, value: string) => {
		const index = find(property);
		if (index < 0) {
			added.push({ text: `${property}:${value}`, raw: `${fold(`${property}:${value}`, eol)}${eol}` });
			return;
		}
		const parts = partsOf(entries[index])!;
		// A transfer encoding or charset describes the old bytes, not the text written now.
		const head = /;(?:ENCODING|CHARSET)=/i.test(parts.head) ? `${parts.group}${property}` : parts.head;
		entries[index] = { text: `${head}:${value}`, raw: `${fold(`${head}:${value}`, eol)}${terminatorOf(entries[index]) || eol}` };
	};
	set("FN", escapeText(wanted));
	set("N", structuredName(wanted));
	entries.splice(end, 0, ...added);
	return entries.map((entry) => entry.raw).join("");
}

/**
 * The card without the EMAIL lines for one address (compared like the reader does: `mailto:` and case ignored). Apple's
 * grouped form goes with its `X-ABLabel` when nothing else is in the group. Everything else is kept.
 */
export function removeCardEmail(body: string, address: string): string {
	if (!isDavAddress(address)) return body;
	const entries = entriesOf(body);
	const isIt = (entry: Entry) => {
		const parts = partsOf(entry);
		return parts?.name === "EMAIL" && parts.value.trim().replace(/^mailto:/i, "").toLowerCase() === address;
	};
	const gone = new Set(entries.filter(isIt));
	if (!gone.size) return body;
	for (const group of new Set([...gone].map((entry) => partsOf(entry)!.group).filter(Boolean))) {
		const rest = entries.filter((entry) => !gone.has(entry) && partsOf(entry)?.group === group);
		if (rest.every((entry) => partsOf(entry)!.name === "X-ABLABEL")) for (const entry of rest) gone.add(entry);
	}
	return entries.filter((entry) => !gone.has(entry)).map((entry) => entry.raw).join("");
}

/** The properties a card made by Mailflare holds; a card with anything else (or any EMAIL) is somebody's, and is never deleted for that. */
const BARE = new Set(["BEGIN", "END", "VERSION", "PRODID", "UID", "FN", "N", "REV"]);

/** Whether a card holds nothing but FN, N, UID, VERSION, PRODID and REV (and its BEGIN and END): no address, no phone number, no custom property. */
export const isBareCard = (body: string): boolean => entriesOf(body).every((entry) => !entry.text.trim() || BARE.has(partsOf(entry)?.name ?? ""));

import { iterIcsLines } from "../calendar/ics-import";
import { cleanLine, cleanText, normalizeContactDetails, withoutEmails } from "./details-utils";
import type { ContactPhoto, ImportedContact, SplitVcard, SplitVcardsResult } from "./vcard-types";

/**
 * Reads vCard files (Google Takeout exports 3.0; 2.1 and 4.0 are read too) for contact import. The file is attacker
 * controllable, so every step is linear and bounded: lines are capped, cards and properties are counted, quoted-printable
 * joins are limited, and no regular expression runs on unbounded text. Nothing in a card is ever fetched.
 * Pure and framework-free: the browser splits and previews, the server parses.
 */

export const MAX_VCARDS = 50_000;
/** A card whose lines add up to more than this is left out (a card is sent to the server whole). */
export const MAX_CARD_CHARS = 128 * 1024;
/** Lines longer than this are cut; a PHOTO line that long is dropped instead of decoded. */
export const MAX_VCARD_LINE_BYTES = 1024 * 1024;
/** The server parses cards the browser has already stripped of photos, so it reads short lines only. */
const PARSE_LINE_BYTES = 64 * 1024;
const MAX_CARD_LINES = 2000;
const MAX_QP_JOINS = 64;
/** Parameter segments read per line, and values kept per parameter name; the rest is skipped, not stored. */
const MAX_PARAM_SEGMENTS = 64;
const MAX_PARAM_VALUES = 20;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_LIST = 50;
const SKIPPED_PROPERTIES = new Set(["LOGO", "SOUND", "KEY"]);
const TYPE_NOISE = new Set(["VOICE", "INTERNET", "PREF", "PARCEL", "POSTAL", "DOM", "INTL", "MSG", "BBS", "MODEM", "ISDN", "PCS", "CAR", "VIDEO", "PAGER"]);
const encoder = new TextEncoder();

type CardLine = { group: string; name: string; params: Map<string, string[]>; value: string };

const upperName = (text: string) => text.trim().toUpperCase();

/** `[group.]NAME[;param...]:value`. One pass; a colon or semicolon inside a double-quoted parameter does not count. */
function parseCardLine(line: string): CardLine | null {
	let nameEnd = 0;
	while (nameEnd < line.length && line[nameEnd] !== ":" && line[nameEnd] !== ";") nameEnd++;
	if (nameEnd === 0 || nameEnd >= line.length) return null;
	let name = line.slice(0, nameEnd);
	let group = "";
	const dot = name.lastIndexOf(".");
	if (dot >= 0) { group = name.slice(0, dot); name = name.slice(dot + 1); }
	const params = new Map<string, string[]>();
	let index = nameEnd;
	let colon = -1;
	let segments = 0;
	while (index < line.length && colon < 0) {
		// At a ";" (or the ":" that ends the parameters).
		if (line[index] === ":") { colon = index; break; }
		index++;
		let quoted = false;
		const start = index;
		while (index < line.length && (quoted || (line[index] !== ";" && line[index] !== ":"))) {
			if (line[index] === "\"") quoted = !quoted;
			index++;
		}
		// Past the cap the segments are only skipped, to find the colon.
		if (++segments > MAX_PARAM_SEGMENTS) continue;
		const raw = line.slice(start, index);
		const eq = raw.indexOf("=");
		const key = upperName(eq < 0 ? "TYPE" : raw.slice(0, eq));
		const values = (eq < 0 ? raw : raw.slice(eq + 1)).replace(/"/g, "").split(",").map((value) => value.trim()).filter(Boolean);
		if (!values.length) continue;
		const known = params.get(key);
		if (!known) { if (params.size < 20) params.set(key, values.slice(0, MAX_PARAM_VALUES)); }
		else for (const value of values) { if (known.length >= MAX_PARAM_VALUES) break; known.push(value); }
	}
	if (colon < 0) return null;
	return { group: group.toUpperCase(), name: upperName(name), params, value: line.slice(colon + 1) };
}

const isQuotedPrintable = (line: CardLine) =>
	(line.params.get("ENCODING") ?? []).some((value) => upperName(value) === "QUOTED-PRINTABLE") || (line.params.get("TYPE") ?? []).some((value) => upperName(value) === "QUOTED-PRINTABLE");

/** Decodes =XX escapes into bytes, then text in the card's charset (UTF-8 when absent or unknown). */
function decodeQuotedPrintable(value: string, charset: string | undefined): string {
	const bytes: number[] = [];
	for (let index = 0; index < value.length && bytes.length < PARSE_LINE_BYTES; index++) {
		const char = value[index];
		const hex = char === "=" ? value.slice(index + 1, index + 3) : "";
		if (hex.length === 2 && /^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(Number.parseInt(hex, 16)); index += 2; }
		else bytes.push(...encoder.encode(char));
	}
	try {
		return new TextDecoder(charset?.trim() || "utf-8").decode(new Uint8Array(bytes));
	} catch {
		return new TextDecoder().decode(new Uint8Array(bytes));
	}
}

/** Splits on `;` that is not escaped with a backslash (an escaped backslash does not escape the next character). */
function splitStructured(value: string): string[] {
	const parts: string[] = [];
	let current = "";
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === "\\" && index + 1 < value.length) { current += char + value[index + 1]; index++; }
		else if (char === ";") { parts.push(current); current = ""; }
		else current += char;
	}
	parts.push(current);
	return parts;
}

/** One pass, so an escaped backslash followed by "n" is not read as a line break. */
function unescapeValue(value: string): string {
	let out = "";
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === "\\" && index + 1 < value.length) {
			const next = value[++index];
			out += next === "n" || next === "N" ? "\n" : next;
		} else out += char;
	}
	return out;
}

/** The value as text: quoted-printable decoded when declared, then escapes resolved. */
const valueText = (line: CardLine) => unescapeValue(isQuotedPrintable(line) ? decodeQuotedPrintable(line.value, line.params.get("CHARSET")?.[0]) : line.value);
/** The `;`-separated parts of a structured value (N, ADR, ORG), each unescaped. */
const structuredParts = (line: CardLine) => splitStructured(isQuotedPrintable(line) ? decodeQuotedPrintable(line.value, line.params.get("CHARSET")?.[0]) : line.value).map(unescapeValue);

/** Apple and Google wrap custom labels as `_$!<Mobile>!$_`. */
const unwrapLabel = (label: string) => (label.startsWith("_$!<") && label.endsWith(">!$_") ? label.slice(4, -4) : label);

function typeOf(line: CardLine, labels: Map<string, string>): string {
	const custom = line.group ? labels.get(line.group) : undefined;
	if (custom) return cleanLine(unwrapLabel(custom), 32);
	const types = (line.params.get("TYPE") ?? []).filter((type) => !TYPE_NOISE.has(upperName(type)) && upperName(type) !== "QUOTED-PRINTABLE" && upperName(type) !== "BASE64");
	return cleanLine(types.map((type) => type.toLowerCase()).join(", "), 32);
}

const isPreferred = (line: CardLine) => (line.params.get("PREF") ?? []).length > 0 || (line.params.get("TYPE") ?? []).some((type) => upperName(type) === "PREF");

function* cardLines(text: string): Generator<CardLine> {
	const iterator = iterIcsLines(encoder.encode(text), PARSE_LINE_BYTES);
	let count = 0;
	let raw = iterator.next();
	while (!raw.done && count++ < MAX_CARD_LINES) {
		const first = raw.value;
		let line = parseCardLine(first);
		raw = iterator.next();
		// Quoted-printable values continue on the next line after a trailing "=". The pieces are collected and joined
		// once, so the work stays linear in the text.
		if (line && isQuotedPrintable(line) && first.endsWith("=")) {
			const parts: string[] = [];
			let tail = first;
			for (let joins = 0; tail.endsWith("=") && !raw.done && joins < MAX_QP_JOINS; joins++) {
				parts.push(tail.slice(0, -1));
				tail = raw.value;
				raw = iterator.next();
			}
			parts.push(tail);
			line = parseCardLine(parts.join(""));
		}
		if (line) yield line;
	}
}

/** Reads one card (the first BEGIN:VCARD ... END:VCARD in `text`, or the whole text when it has no markers). */
export function parseVcard(text: string): ImportedContact {
	const contact: ImportedContact = { name: null, emails: [], details: {} };
	const lines: CardLine[] = [];
	let inside = false;
	let marked = false;
	for (const line of cardLines(text)) {
		if (line.name === "BEGIN" && upperName(line.value) === "VCARD") { if (marked) break; inside = true; marked = true; continue; }
		if (line.name === "END" && upperName(line.value) === "VCARD") { if (inside) break; continue; }
		if (marked && !inside) continue;
		lines.push(line);
	}
	const labels = new Map<string, string>();
	for (const line of lines) if (line.group && line.name === "X-ABLABEL") labels.set(line.group, valueText(line));
	let fn: string | null = null;
	let structured: string | null = null;
	const emails: { value: string; preferred: boolean }[] = [];
	const phones: { type: string; value: string }[] = [];
	const addresses: { type: string; formatted: string }[] = [];
	const details = contact.details;
	for (const line of lines) {
		switch (line.name) {
			case "FN": fn ??= cleanLine(valueText(line), 100) || null; break;
			case "N": {
				const [family = "", given = "", additional = ""] = structuredParts(line);
				structured ??= cleanLine([given, additional, family].map((part) => cleanLine(part, 100)).filter(Boolean).join(" "), 100) || null;
				break;
			}
			case "EMAIL":
				if (emails.length < MAX_LIST) emails.push({ value: valueText(line).trim().replace(/^mailto:/i, ""), preferred: isPreferred(line) });
				break;
			case "TEL":
				if (phones.length < MAX_LIST) phones.push({ type: typeOf(line, labels), value: valueText(line).trim().replace(/^tel:/i, "") });
				break;
			case "ADR":
				if (addresses.length < MAX_LIST) {
					const parts = structuredParts(line).map((part) => cleanLine(part, 200)).filter(Boolean);
					if (parts.length) addresses.push({ type: typeOf(line, labels), formatted: parts.join(", ") });
				}
				break;
			case "ORG": details.organization ??= structuredParts(line).map((part) => cleanLine(part, 200)).filter(Boolean).join(", "); break;
			case "TITLE": details.title ??= valueText(line); break;
			case "BDAY": details.birthday ??= valueText(line); break;
			case "NOTE": details.note ??= cleanText(valueText(line), 4000); break;
			default: break;
		}
	}
	contact.name = fn ?? structured;
	contact.emails = [...emails.filter((email) => email.preferred), ...emails.filter((email) => !email.preferred)].map((email) => email.value).slice(0, 20);
	if (phones.length) details.phones = phones;
	if (addresses.length) details.addresses = addresses;
	// Caps, cleaning and de-duplication are shared with the server's own check of stored details.
	contact.details = withoutEmails(normalizeContactDetails(details));
	return contact;
}

const readPhoto = (line: CardLine, truncated: boolean): ContactPhoto | null => {
	const value = line.value.trim();
	if (!value) return null;
	const uri = (line.params.get("VALUE") ?? []).some((item) => upperName(item) === "URI");
	if (uri || /^[a-z][a-z0-9+.-]{0,15}:/i.test(value.slice(0, 20)) && !/^data:/i.test(value.slice(0, 5))) return { kind: "uri" };
	if (truncated) return null;
	const data = /^data:[^,]{0,100},/i.exec(value.slice(0, 120));
	return { kind: "inline", base64: data ? value.slice(data[0].length) : value };
};

/**
 * Splits a vCard file into cards. Each card's text is its unfolded lines without PHOTO, LOGO, SOUND and KEY (the
 * server never sees image data); a PHOTO is reported beside it. A card without END:VCARD ends at the next BEGIN or the
 * end of the file. Unfolding happens on bytes, before decoding.
 */
export function splitVcards(bytes: Uint8Array, maxLine = MAX_VCARD_LINE_BYTES, maxCards = MAX_VCARDS): SplitVcardsResult {
	const result: SplitVcardsResult = { cards: [], tooLarge: 0, truncated: false };
	let lines: string[] | null = null;
	let chars = 0;
	let photo: ContactPhoto | null = null;
	let big = false;
	const finish = () => {
		if (lines === null) return;
		if (big) result.tooLarge++;
		else result.cards.push({ text: lines.join("\n"), photo } satisfies SplitVcard);
		lines = null;
	};
	// A UTF-8 byte order mark would hide the first BEGIN line.
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	for (const line of iterIcsLines(bytes.subarray(start), maxLine)) {
		const head = line.slice(0, 32).toUpperCase();
		if (head.startsWith("BEGIN:") && line.slice(6).trim().toUpperCase() === "VCARD") {
			finish();
			if (result.cards.length + result.tooLarge >= maxCards) { result.truncated = true; return result; }
			lines = []; chars = 0; photo = null; big = false;
			continue;
		}
		if (lines === null) continue;
		if (head.startsWith("END:") && line.slice(4).trim().toUpperCase() === "VCARD") { finish(); continue; }
		const name = upperName(line.slice(0, Math.max(line.indexOf(":"), 0) || 0).split(";")[0].split(".").pop() ?? "");
		if (name === "PHOTO") {
			const parsed = parseCardLine(line);
			if (parsed && !photo) photo = readPhoto(parsed, line.length >= maxLine - 1);
			continue;
		}
		if (SKIPPED_PROPERTIES.has(name)) continue;
		chars += line.length + 1;
		if (chars > MAX_CARD_CHARS) big = true;
		if (!big) lines.push(line);
	}
	finish();
	return result;
}

const IMAGE_SIGNATURES: { mime: string; bytes: number[] }[] = [
	{ mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
	{ mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

/**
 * An inline photo as bytes and image type, or null. The data must be plain base64, decode to at most 10 MB and start
 * like a JPEG, PNG, GIF or WebP file; the type comes from those first bytes, never from the card. Anything else, SVG
 * included, is refused. Call this in the browser only.
 */
export function decodeContactPhoto(photo: ContactPhoto | null): { bytes: Uint8Array; mime: string } | null {
	if (!photo || photo.kind !== "inline") return null;
	const base64 = photo.base64.replace(/\s+/g, "");
	if (!base64 || base64.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		return null;
	}
	if (binary.length > MAX_PHOTO_BYTES) return null;
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	const webp = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
	const mime = webp ? "image/webp" : IMAGE_SIGNATURES.find((signature) => signature.bytes.every((byte, index) => bytes[index] === byte))?.mime;
	return mime ? { bytes, mime } : null;
}

import { cleanLine, cleanText, normalizeContactDetails, withoutEmails } from "./details-utils";
import type { ImportedContact } from "./vcard-types";

/**
 * Reads the contacts CSV of Google Contacts / Takeout, in the current header style ("First Name", "E-mail 1 - Value")
 * and the legacy one ("Name", "Given Name", "E-mail 1 - Type"). One linear pass over the text with caps on columns, rows
 * and field length; no regular expression runs on a whole file or a whole field. Pure: the browser reads and previews,
 * the server maps the rows it is sent.
 */

export const MAX_CSV_COLUMNS = 200;
export const MAX_CSV_ROWS = 50_000;
export const MAX_CSV_FIELD = 10_000;
const MAX_HEADER_NAME = 100;
const SEPARATOR = " ::: ";
const MAX_VALUES_PER_CELL = 20;

/** UTF-8 (a byte order mark is dropped) or, for old Google exports that start `FF FE`, UTF-16LE. */
export function decodeContactsCsv(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	return new TextDecoder("utf-8").decode(bytes);
}

/**
 * RFC 4180: quoted fields may hold commas, doubled quotes and line breaks; CRLF, LF and a bare CR end a row; blank
 * lines are skipped. A field is cut at MAX_CSV_FIELD characters (the rest is read and dropped), a row at
 * MAX_CSV_COLUMNS fields, and reading stops after `maxRows` rows, with `truncated` set when more followed.
 */
export function parseCsv(text: string, limits: { maxRows?: number } = {}): { rows: string[][]; truncated: boolean } {
	const maxRows = limits.maxRows ?? MAX_CSV_ROWS;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let touched = false;
	let truncated = false;
	const endField = () => {
		if (row.length < MAX_CSV_COLUMNS) row.push(field);
		field = "";
		touched = false;
	};
	const endRow = () => {
		endField();
		if (!(row.length === 1 && row[0] === "")) rows.push(row);
		row = [];
	};
	for (let index = 0; index < text.length; index++) {
		if (rows.length >= maxRows) {
			// Only blank lines after the last allowed row are not "more".
			for (let rest = index; rest < text.length && !truncated; rest++) truncated = text[rest] !== "\n" && text[rest] !== "\r";
			break;
		}
		const char = text[index];
		if (quoted) {
			if (char !== "\"") { if (field.length < MAX_CSV_FIELD) field += char; }
			else if (text[index + 1] === "\"") { if (field.length < MAX_CSV_FIELD) field += char; index++; }
			else quoted = false;
		} else if (char === "\"" && !touched) { quoted = true; touched = true; }
		else if (char === ",") endField();
		else if (char === "\r") { if (text[index + 1] === "\n") index++; endRow(); }
		else if (char === "\n") endRow();
		else { touched = true; if (field.length < MAX_CSV_FIELD) field += char; }
	}
	if (!truncated && (touched || field !== "" || row.length > 0 || quoted)) endRow();
	return { rows, truncated };
}

const key = (name: string) => name.slice(0, MAX_HEADER_NAME).trim().toLowerCase();
const EMAIL_COLUMN = /^e-?mail (\d{1,3}) - (value|label|type)$/;
const PHONE_COLUMN = /^phone (\d{1,3}) - (value|label|type)$/;
const ADDRESS_COLUMN = /^address (\d{1,3}) - (formatted|label|type)$/;

const hasNameColumn = (names: string[]) => names.includes("first name") || names.includes("given name") || names.includes("name");
const hasEmailColumn = (names: string[]) => names.some((name) => /^e-?mail \d{1,3} - value$/.test(name));

/** A CSV whose header has a name column and an e-mail value column, which both Google styles do. */
export function isGoogleContactsHeader(header: string[]): boolean {
	const names = header.slice(0, MAX_CSV_COLUMNS).map(key);
	return hasNameColumn(names) && hasEmailColumn(names);
}

type Slot = { value: number; label: number };

/** The value and label columns of each numbered group (E-mail 1, E-mail 2, ...), in group order. */
function slots(names: string[], pattern: RegExp, valueName: string): Slot[] {
	const found = new Map<number, Slot>();
	names.forEach((name, column) => {
		const match = pattern.exec(name);
		if (!match) return;
		const number = Number(match[1]);
		const slot = found.get(number) ?? { value: -1, label: -1 };
		if (match[2] === valueName) slot.value = column; else slot.label = column;
		found.set(number, slot);
	});
	return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot).filter((slot) => slot.value >= 0);
}

const split = (cell: string | undefined) => (cell ?? "").split(SEPARATOR, MAX_VALUES_PER_CELL).map((part) => part.trim());

/** A mapper from one row to a contact for this header; build it once per file or request. */
export function googleCsvMapper(header: string[]): (row: string[]) => ImportedContact {
	const names = header.slice(0, MAX_CSV_COLUMNS).map(key);
	const column = (...wanted: string[]) => names.findIndex((name) => wanted.includes(name));
	const nameParts = [column("name"), [column("first name"), column("middle name"), column("last name")], [column("given name"), column("additional name"), column("family name")]] as const;
	const organization = column("organization name", "organization 1 - name");
	const title = column("organization title", "organization 1 - title");
	const birthday = column("birthday");
	const notes = column("notes");
	const emails = slots(names, EMAIL_COLUMN, "value");
	const phones = slots(names, PHONE_COLUMN, "value");
	const addresses = slots(names, ADDRESS_COLUMN, "formatted");
	return (row) => {
		const cell = (index: number) => (index >= 0 ? row[index] ?? "" : "");
		const assembled = (columns: readonly number[]) => cleanLine(columns.map(cell).map((part) => cleanLine(part, 100)).filter(Boolean).join(" "), 100);
		const name = cleanLine(cell(nameParts[0]), 100) || assembled(nameParts[1]) || assembled(nameParts[2]) || null;
		const starred: string[] = [];
		const plain: string[] = [];
		for (const slot of emails) {
			const labels = split(cell(slot.label));
			split(cell(slot.value)).forEach((value, position) => {
				// The legacy export marks the primary address with a leading "* " on its type.
				if (value) (labels[position]?.startsWith("*") ? starred : plain).push(value);
			});
		}
		const entries = (list: Slot[]) => list.flatMap((slot) => {
			const labels = split(cell(slot.label));
			return split(cell(slot.value)).map((value, position) => ({ value, type: cleanLine(labels[position]?.replace(/^\*\s*/, "") ?? labels[0]?.replace(/^\*\s*/, ""), 32) }));
		});
		const details = normalizeContactDetails({
			phones: entries(phones),
			addresses: entries(addresses).map(({ value, type }) => ({ formatted: value, type })),
			organization: cell(organization),
			title: cell(title),
			birthday: cell(birthday),
			note: cleanText(cell(notes), 4000),
		});
		return { name, emails: [...starred, ...plain].slice(0, 20), details: withoutEmails(details) };
	};
}

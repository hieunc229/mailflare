import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-google-csv-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { c: join(root, "src/lib/contacts/google-csv.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { parseCsv, decodeContactsCsv, isGoogleContactsHeader, googleCsvMapper, MAX_CSV_COLUMNS, MAX_CSV_ROWS, MAX_CSV_FIELD } = await import(pathToFileURL(join(dir, "c.mjs")).href);

const CURRENT = ["First Name", "Middle Name", "Last Name", "Phonetic First Name", "Nickname", "Organization Name", "Organization Title", "Birthday", "Notes", "Labels", "E-mail 1 - Label", "E-mail 1 - Value", "E-mail 2 - Label", "E-mail 2 - Value", "Phone 1 - Label", "Phone 1 - Value", "Address 1 - Label", "Address 1 - Formatted"];
const LEGACY = ["Name", "Given Name", "Additional Name", "Family Name", "Birthday", "Notes", "Group Membership", "E-mail 1 - Type", "E-mail 1 - Value", "Phone 1 - Type", "Phone 1 - Value", "Address 1 - Type", "Address 1 - Formatted", "Organization 1 - Name", "Organization 1 - Title"];

test("RFC 4180: quotes, doubled quotes, embedded commas and newlines, CRLF, LF and bare CR, a BOM-free read", () => {
	const text = 'a,b,c\r\n1,"x, y","say ""hi"""\r\n"multi\nline",2,3\n4,5,6\r7,8,9';
	assert.deepEqual(parseCsv(text).rows, [["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["multi\nline", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]]);
});

test("blank lines are skipped, a quote in the middle of a field is literal, an unclosed quote takes the rest", () => {
	assert.deepEqual(parseCsv("a,b\n\n\nc,d").rows, [["a", "b"], ["c", "d"]]);
	assert.deepEqual(parseCsv('a,b"c,d\n').rows, [["a", 'b"c', "d"]]);
	assert.deepEqual(parseCsv('a,"open\nstill open,x').rows, [["a", "open\nstill open,x"]]);
	assert.deepEqual(parseCsv("").rows, []);
	assert.deepEqual(parseCsv("a,b,").rows, [["a", "b", ""]]);
});

test("limits: columns, rows and field length", () => {
	assert.equal(parseCsv(Array.from({ length: 300 }, (_, n) => n).join(",")).rows[0].length, MAX_CSV_COLUMNS);
	const many = parseCsv(Array.from({ length: 20 }, (_, n) => `r${n}`).join("\n"), { maxRows: 5 });
	assert.equal(many.rows.length, 5);
	assert.equal(many.truncated, true);
	assert.equal(typeof MAX_CSV_ROWS, "number");
	const wide = parseCsv(`"${"z".repeat(MAX_CSV_FIELD * 3)}",b`).rows[0];
	assert.equal(wide[0].length, MAX_CSV_FIELD);
	assert.equal(wide[1], "b");
});

test("trailing blank lines after the last allowed row do not mark the file truncated", () => {
	assert.equal(parseCsv("a\nb\n\n\r\n\n", { maxRows: 2 }).truncated, false);
	assert.deepEqual(parseCsv("a\nb\n\n\r\n\n", { maxRows: 2 }).rows, [["a"], ["b"]]);
	assert.equal(parseCsv("a\nb\nc\n", { maxRows: 2 }).truncated, true);
	assert.equal(parseCsv("a\nb\n\n\nc", { maxRows: 2 }).truncated, true);
});

test("a hostile file parses in linear time", () => {
	const started = performance.now();
	parseCsv('"'.repeat(200_000) + "\n" + ",".repeat(200_000) + "\n" + '""'.repeat(100_000));
	parseCsv("a,".repeat(300_000));
	assert.ok(performance.now() - started < 1500);
});

test("decoding: UTF-8 with or without a BOM, and UTF-16LE with a BOM", () => {
	const text = "Name,E-mail 1 - Value\nJosé,j@example.com\n";
	assert.equal(decodeContactsCsv(Buffer.from(text)), text);
	assert.equal(decodeContactsCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
	assert.equal(decodeContactsCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text);
});

test("the Google header is recognised in both generations and a random CSV is not", () => {
	assert.equal(isGoogleContactsHeader(CURRENT), true);
	assert.equal(isGoogleContactsHeader(LEGACY), true);
	assert.equal(isGoogleContactsHeader(["date", "amount", "memo"]), false);
	assert.equal(isGoogleContactsHeader(["Name", "Amount"]), false);
	assert.equal(isGoogleContactsHeader([]), false);
});

test("the current header style maps names, addresses, phones, organization, birthday, notes", () => {
	const map = googleCsvMapper(CURRENT);
	const contact = map(["Jane", "Q.", "Doe", "", "", "Acme", "Engineer", "1980-05-01", "line one\nline two", "* myContacts", "Work", "work@example.com", "Home", "home@example.com", "Mobile", "+1 555 0100", "Home", "1 Main St\nSpringfield"]);
	assert.equal(contact.name, "Jane Q. Doe");
	assert.deepEqual(contact.emails, ["work@example.com", "home@example.com"]);
	assert.deepEqual(contact.details.phones, [{ type: "Mobile", value: "+1 555 0100" }]);
	assert.deepEqual(contact.details.addresses, [{ type: "Home", formatted: "1 Main St Springfield" }]);
	assert.equal(contact.details.organization, "Acme");
	assert.equal(contact.details.title, "Engineer");
	assert.equal(contact.details.birthday, "1980-05-01");
	assert.equal(contact.details.note, "line one\nline two");
});

test("the legacy header style maps too, and a leading * marks the primary address", () => {
	const map = googleCsvMapper(LEGACY);
	const contact = map(["Jane Doe", "Jane", "", "Doe", "--05-01", "n", "Friends", "Work", "a@example.com ::: * Home", "Cell", "555 0100", "Home", "2 Road", "Acme", "CEO"]);
	assert.equal(contact.name, "Jane Doe");
	assert.equal(contact.details.organization, "Acme");
	assert.equal(contact.details.title, "CEO");
	assert.equal(contact.details.birthday, "--05-01");
	assert.deepEqual(contact.details.phones, [{ type: "Cell", value: "555 0100" }]);
});

test(" ::: splits several values in one cell, with labels paired by position, and the starred one comes first", () => {
	const map = googleCsvMapper(["Name", "E-mail 1 - Type", "E-mail 1 - Value"]);
	const contact = map(["X", "Work ::: * Home", "w@example.com ::: h@example.com"]);
	assert.deepEqual(contact.emails, ["h@example.com", "w@example.com"]);
});

test("a row without a name or address still maps; short rows and junk never throw", () => {
	const map = googleCsvMapper(CURRENT);
	assert.equal(map([]).name, null);
	assert.deepEqual(map(["Only"]).emails, []);
	assert.equal(map(["x", "y"]).name, "x y");
	const hostile = googleCsvMapper(["Name", ...Array.from({ length: 150 }, (_, n) => `E-mail ${n} - Value`)]);
	assert.ok(hostile(["N", ...Array.from({ length: 150 }, (_, n) => `e${n}@example.com`)]).emails.length <= 20);
});

test("cell text is cleaned and capped", () => {
	const map = googleCsvMapper(CURRENT);
	const row = Array(CURRENT.length).fill("");
	row[0] = "Eve\u0007\u0000 Mallory";
	row[8] = "n".repeat(50_000);
	row[15] = "5".repeat(500);
	const contact = map(row);
	assert.equal(contact.name, "Eve Mallory");
	assert.ok(contact.details.note.length <= 4000);
	assert.ok(contact.details.phones[0].value.length <= 64);
});

test("the Photo column is a URL and is ignored", () => {
	const map = googleCsvMapper([...CURRENT, "Photo"]);
	const row = Array(CURRENT.length + 1).fill("");
	row[11] = "a@example.com";
	row[CURRENT.length] = "https://lh3.googleusercontent.com/x";
	assert.equal(JSON.stringify(map(row)).includes("googleusercontent"), false);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-contact-details-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { d: join(root, "src/lib/contacts/details-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { normalizeContactDetails, parseStoredDetails, importedContactEmails, mergeImportedContact, mergeContactDetails, normalizeBirthday, formatBirthday, csvSafeCell } = await import(pathToFileURL(join(dir, "d.mjs")).href);

test("a manual contact with a name keeps it; the imported name does not replace it", () => {
	assert.deepEqual(mergeImportedContact({ displayName: "Mum", source: "manual" }, "Jane Doe"), { displayName: "Mum", source: "manual" });
});

test("an inbound or missing contact gets the imported name and becomes an import contact", () => {
	assert.deepEqual(mergeImportedContact({ displayName: "Learned Name", source: "inbound" }, "Jane Doe"), { displayName: "Jane Doe", source: "import" });
	assert.deepEqual(mergeImportedContact(null, "Jane Doe"), { displayName: "Jane Doe", source: "import" });
});

test("an outbound contact keeps its source when a card is imported onto it; the name rules still apply", () => {
	assert.deepEqual(mergeImportedContact({ displayName: null, source: "outbound" }, "Jane Doe"), { displayName: "Jane Doe", source: "outbound" });
	assert.deepEqual(mergeImportedContact({ displayName: "Sent To", source: "outbound" }, "Jane Doe"), { displayName: "Jane Doe", source: "outbound" });
	assert.deepEqual(mergeImportedContact({ displayName: "Sent To", source: "outbound" }, null), { displayName: "Sent To", source: "outbound" });
});

test("a nameless manual contact takes the imported name but stays manual", () => {
	assert.deepEqual(mergeImportedContact({ displayName: "  ", source: "manual" }, "Jane Doe"), { displayName: "Jane Doe", source: "manual" });
});

test("a re-import updates a name it set earlier (source import) and never one the user edited (manual)", () => {
	assert.deepEqual(mergeImportedContact({ displayName: "Jane D.", source: "import" }, "Jane Doe"), { displayName: "Jane Doe", source: "import" });
	assert.deepEqual(mergeImportedContact({ displayName: "Jane D.", source: "import" }, null), { displayName: "Jane D.", source: "import" });
	assert.deepEqual(mergeImportedContact({ displayName: "Janey", source: "manual" }, "Jane Doe"), { displayName: "Janey", source: "manual" });
});

test("without an imported name the name stays, and an inbound contact on an imported card still becomes import", () => {
	assert.deepEqual(mergeImportedContact({ displayName: "Learned", source: "inbound" }, null), { displayName: "Learned", source: "import" });
	assert.deepEqual(mergeImportedContact({ displayName: null, source: "inbound" }, "  \u0000 "), { displayName: null, source: "import" });
	assert.deepEqual(mergeImportedContact(null, null), { displayName: null, source: "import" });
});

test("details merge: phones and addresses are united by normalized value, existing fields survive a card that lacks them", () => {
	const existing = { emails: ["a@x.co"], phones: [{ type: "cell", value: "+1 555 0100" }], addresses: [{ type: "home", formatted: "1 Main St" }], organization: "Acme", birthday: "1980-05-01", note: "keep me" };
	const merged = mergeContactDetails(existing, { emails: ["a@x.co", "b@x.co"], phones: [{ type: "work", value: "+1 (555) 0100" }, { type: "work", value: "+1 555 0199" }], addresses: [{ type: "work", formatted: "1 MAIN ST" }, { type: "work", formatted: "2 Side St" }] });
	assert.deepEqual(merged.emails, ["a@x.co", "b@x.co"]);
	assert.deepEqual(merged.phones, [{ type: "cell", value: "+1 555 0100" }, { type: "work", value: "+1 555 0199" }]);
	assert.deepEqual(merged.addresses.map((item) => item.formatted), ["1 Main St", "2 Side St"]);
	assert.equal(merged.organization, "Acme");
	assert.equal(merged.birthday, "1980-05-01");
	assert.equal(merged.note, "keep me");
	assert.equal(mergeContactDetails(existing, { organization: "New Co", note: "new" }).organization, "New Co");
	assert.equal(mergeContactDetails(existing, { organization: "New Co", note: "new" }).note, "new");
	assert.deepEqual(mergeContactDetails(null, { organization: "X" }), { organization: "X" });
	assert.deepEqual(mergeContactDetails(existing, existing), normalizeContactDetails(existing));
});

test("an imported name is cleaned and capped at 100 characters", () => {
	const merged = mergeImportedContact(null, `A\u0007\n${"b".repeat(300)}`);
	assert.ok(merged.displayName.length <= 100);
	assert.ok(!/[\u0000-\u001f]/.test(merged.displayName));
});

test("details are normalized: unknown keys dropped, text cleaned, duplicates and empties removed, caps applied", () => {
	const details = normalizeContactDetails({
		evil: "<script>", __proto__: { polluted: true },
		emails: ["A@B.co", "a@b.co", "Name <x@y.zz>", "no-at", "has space@x.co"],
		phones: [{ type: "cell", value: "+1 (555) 0100" }, { type: "home", value: "+1 555 0100" }, { type: "x", value: "" }, "bad", null],
		addresses: [{ type: "home", formatted: "1 Main St\nSpringfield" }, { type: "home", formatted: "1 main st springfield" }],
		organization: "Acme\u0000", title: 5, birthday: "1980-05-01", note: "a\r\nb\u0000c",
	});
	assert.deepEqual(details, {
		emails: ["a@b.co"],
		phones: [{ type: "cell", value: "+1 (555) 0100" }],
		addresses: [{ type: "home", formatted: "1 Main St Springfield" }],
		organization: "Acme", birthday: "1980-05-01", note: "a\nbc",
	});
	assert.equal(Object.prototype.polluted, undefined);
	assert.deepEqual(normalizeContactDetails("nope"), {});
	assert.deepEqual(normalizeContactDetails(null), {});
	assert.deepEqual(normalizeContactDetails({ phones: "x", emails: 5 }), {});
});

test("caps: 20 emails and phones, 10 addresses, 4000-character notes, 64-character phones", () => {
	const details = normalizeContactDetails({
		emails: Array.from({ length: 50 }, (_, n) => `e${n}@x.co`),
		phones: Array.from({ length: 50 }, (_, n) => ({ type: "t".repeat(100), value: `${n}`.repeat(200) })),
		addresses: Array.from({ length: 50 }, (_, n) => ({ type: "h", formatted: `${n} Road` })),
		note: "n".repeat(10_000),
	});
	assert.equal(details.emails.length, 20);
	assert.equal(details.phones.length, 20);
	assert.ok(details.phones.every((phone) => phone.value.length <= 64 && phone.type.length <= 32));
	assert.equal(details.addresses.length, 10);
	assert.equal(details.note.length, 4000);
});

test("stored details are normalized on read; bad JSON means no details", () => {
	assert.deepEqual(parseStoredDetails('{"organization":"Acme","x":1}'), { organization: "Acme" });
	assert.deepEqual(parseStoredDetails("{nope"), {});
	assert.deepEqual(parseStoredDetails(null), {});
	assert.deepEqual(parseStoredDetails("x".repeat(70_000)), {});
});

test("addresses must be bare, valid and unique, at most 20", () => {
	assert.deepEqual(importedContactEmails(["J@Example.COM", "j@example.com", " k@example.com ", "Name <l@example.com>", "m@localhost", 5, null, "a,b@c.co"]), ["j@example.com", "k@example.com"]);
	assert.equal(importedContactEmails(Array.from({ length: 40 }, (_, n) => `u${n}@example.com`)).length, 20);
	assert.deepEqual(importedContactEmails([`${"a".repeat(300)}@example.com`]), []);
});

test("birthdays: full, yearless, compact and impossible", () => {
	assert.equal(normalizeBirthday("1980-05-01"), "1980-05-01");
	assert.equal(normalizeBirthday("19800501"), "1980-05-01");
	assert.equal(normalizeBirthday("--0501"), "--05-01");
	assert.equal(normalizeBirthday("--05-01"), "--05-01");
	assert.equal(normalizeBirthday("1980-13-01"), undefined);
	assert.equal(normalizeBirthday("May 1"), undefined);
});

test("csvSafeCell neutralizes a leading = + - @, tab or CR for spreadsheets", () => {
	for (const value of ["=SUM(A1)", "+1555", "-2", "@cmd", "\tx", "\rx"]) assert.equal(csvSafeCell(value), `'${value}`);
	assert.equal(csvSafeCell("Jane"), "Jane");
	assert.equal(csvSafeCell(""), "");
});

test("birthdays display in the reader's language, with or without a year", () => {
	assert.equal(formatBirthday("1980-05-01", "en"), "May 1, 1980");
	assert.equal(formatBirthday("--05-01", "en"), "May 1");
	assert.equal(formatBirthday("--05-01", "de"), "1. Mai");
	assert.equal(formatBirthday("garbage", "en"), "garbage");
	assert.equal(formatBirthday("--05-01", "not a locale!"), "--05-01");
});

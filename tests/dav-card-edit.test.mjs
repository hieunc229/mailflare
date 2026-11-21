import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dav-card-edit-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { buildCard, renameCard, removeCardEmail, isBareCard } from "./src/lib/dav/card-edit.ts";
			export { parseCard } from "./src/lib/dav/card-parse.ts";
		`,
		resolveDir: root,
		sourcefile: "dav-card-edit-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { buildCard, renameCard, removeCardEmail, isBareCard, parseCard } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

/** What an iPhone stores: grouped e-mail with a label, an N with a prefix, a folded PHOTO, a custom property. */
const phoneCard = [
	"BEGIN:VCARD",
	"VERSION:3.0",
	"PRODID:-//Apple Inc.//iOS 26//EN",
	"UID:phone-1",
	"N:Lee;Ann;Marie;Dr.;PhD",
	"FN:Dr. Ann Marie Lee PhD",
	"ORG:Example Ltd;",
	"item1.EMAIL;type=INTERNET;type=pref:Ann@Example.test",
	"item1.X-ABLabel:work",
	"item2.EMAIL;type=INTERNET:ann.home@example.test",
	"TEL;type=CELL;type=VOICE;type=pref:+1 555 0100",
	"PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUV",
	" FRUbGBgbGRQZFRUV/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
	"X-CUSTOM-THING:keep me",
	"END:VCARD",
	"",
].join("\r\n");

const lines = (body) => body.split("\r\n");

test("a card made by Mailflare is a 3.0 card the reader accepts, with N split on the last space", () => {
	const body = buildCard({ uid: "mf-1", name: "Ann Marie Lee", email: "ann@example.test" });
	assert.match(body, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
	assert.ok(body.endsWith("END:VCARD\r\n"));
	assert.ok(body.includes("\r\nPRODID:-//Mailflare//Contacts//EN\r\n"));
	assert.ok(body.includes("\r\nN:Lee;Ann Marie;;;\r\n"));
	assert.ok(body.includes("\r\nEMAIL;TYPE=INTERNET:ann@example.test\r\n"));
	assert.deepEqual(parseCard(body), { uid: "mf-1", version: "3.0", fn: "Ann Marie Lee", emails: ["ann@example.test"], group: false });
});

test("a card without a name is named after its address; a one-word name is the family name", () => {
	const nameless = buildCard({ uid: "mf-2", name: null, email: "who@example.test" });
	assert.equal(parseCard(nameless).fn, "who@example.test");
	assert.ok(buildCard({ uid: "mf-3", name: "Cher", email: "c@example.test" }).includes("\r\nN:Cher;;;;\r\n"));
});

test("a name can never add a property or break a line", () => {
	const evil = "Ann,\r\nTEL:+1 555;x\\y\nEMAIL:evil@example.test";
	const body = buildCard({ uid: "mf-4", name: evil, email: "ann@example.test" });
	const parsed = parseCard(body);
	assert.deepEqual(parsed.emails, ["ann@example.test"]);
	assert.ok(!lines(body).some((line) => line.startsWith("TEL:") || line.startsWith("EMAIL:evil")));
	const renamed = renameCard(phoneCard, evil);
	assert.deepEqual(parseCard(renamed).emails, ["ann@example.test", "ann.home@example.test"]);
	assert.ok(!lines(renamed).some((line) => line.startsWith("TEL:+1 555;x")));
});

test("a rename rewrites FN and N and keeps every other line byte for byte", () => {
	const renamed = renameCard(phoneCard, "Anna Lee");
	const before = lines(phoneCard);
	const after = lines(renamed);
	assert.equal(after.length, before.length);
	for (let i = 0; i < before.length; i++) {
		if (before[i].startsWith("FN:")) assert.equal(after[i], "FN:Anna Lee");
		else if (before[i].startsWith("N:")) assert.equal(after[i], "N:Lee;Anna;;;");
		else assert.equal(after[i], before[i]);
	}
	assert.equal(parseCard(renamed).fn, "Anna Lee");
});

test("renaming to the name the card already has changes nothing, so no change-log row follows", () => {
	assert.equal(renameCard(phoneCard, "Dr. Ann Marie Lee PhD"), phoneCard);
	assert.equal(renameCard(phoneCard, "  Dr. Ann Marie Lee PhD  "), phoneCard);
});

test("a rename keeps the line ending style, folds in untouched lines and parameters on FN", () => {
	const folded = "BEGIN:VCARD\nVERSION:4.0\nUID:u\nFN;PREF=1:Old\n  Name\nNOTE:line one\n line two\nEND:VCARD\n";
	const renamed = renameCard(folded, "New Name");
	assert.equal(renamed, "BEGIN:VCARD\nVERSION:4.0\nUID:u\nFN;PREF=1:New Name\nNOTE:line one\n line two\nN:Name;New;;;\nEND:VCARD\n");
});

test("a card without FN or N gets them before END, and a body that is not one card is returned as it was", () => {
	const bare = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u\r\nEMAIL:a@example.test\r\nEND:VCARD\r\n";
	const named = renameCard(bare, "Ann Lee");
	assert.equal(named, "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u\r\nEMAIL:a@example.test\r\nFN:Ann Lee\r\nN:Lee;Ann;;;\r\nEND:VCARD\r\n");
	assert.equal(renameCard("not a card", "X"), "not a card");
});

test("removing an address drops its EMAIL lines (any case, mailto:, groups with their label) and nothing else", () => {
	const removed = removeCardEmail(phoneCard, "ann@example.test");
	const before = lines(phoneCard);
	assert.deepEqual(
		before.filter((line) => !lines(removed).includes(line)),
		["item1.EMAIL;type=INTERNET;type=pref:Ann@Example.test", "item1.X-ABLabel:work"],
	);
	assert.deepEqual(parseCard(removed).emails, ["ann.home@example.test"]);
	assert.equal(removeCardEmail(phoneCard, "nobody@example.test"), phoneCard);
	const mailto = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:u\r\nEMAIL:mailto:A@Example.test\r\nEMAIL:b@example.test\r\nEND:VCARD\r\n";
	assert.equal(removeCardEmail(mailto, "a@example.test"), "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:u\r\nEMAIL:b@example.test\r\nEND:VCARD\r\n");
});

test("a group label that other properties share is kept", () => {
	const shared = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u\r\nitem1.EMAIL:a@example.test\r\nitem1.X-ABLabel:work\r\nitem1.URL:https://example.test\r\nEND:VCARD\r\n";
	assert.equal(removeCardEmail(shared, "a@example.test"), "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u\r\nitem1.X-ABLabel:work\r\nitem1.URL:https://example.test\r\nEND:VCARD\r\n");
});

test("group cards are recognised in both spellings", () => {
	assert.equal(parseCard("BEGIN:VCARD\r\nVERSION:4.0\r\nUID:g\r\nKIND:group\r\nFN:Team\r\nEND:VCARD\r\n").group, true);
	assert.equal(parseCard("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:g\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nFN:Team\r\nEND:VCARD\r\n").group, true);
	assert.equal(parseCard("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p\r\nKIND:individual\r\nFN:Ann\r\nEND:VCARD\r\n").group, false);
});

test("escaped characters survive: the same name written twice is recognised as unchanged", () => {
	const name = "Lee\\Ann; Jr, MD";
	const once = renameCard(phoneCard, name);
	assert.ok(once.includes("FN:Lee\\\\Ann\\; Jr\\, MD"));
	assert.equal(parseCard(once).fn, name);
	assert.equal(renameCard(once, name), once);
});

const octets = (line) => new TextEncoder().encode(line).byteLength;
const physical = (body) => body.split("\r\n").filter(Boolean);

test("new FN and N lines are folded at 75 octets without cutting a UTF-8 character", () => {
	// 70 ASCII letters, then a 4-octet character that would straddle octet 75, then more accented text.
	const name = `${"a".repeat(70)}\u{1F600} ${"\u00e9".repeat(80)} Lee`;
	for (const body of [buildCard({ uid: "u", name, email: "a@example.test" }), renameCard(phoneCard, name)]) {
		const lines = physical(body).filter((line) => !phoneCard.includes(line));
		assert.ok(lines.every((line) => octets(line) <= 75), lines.filter((line) => octets(line) > 75).join(" | "));
		assert.ok(lines.some((line) => line.startsWith(" ")), "a long name is folded");
		assert.ok(!body.includes("\uFFFD"));
		assert.equal(parseCard(body).fn, name.slice(0, 200));
		assert.equal(renameCard(body, name), body, "the folded name is recognised as unchanged");
	}
	assert.equal(buildCard({ uid: "u", name: "Ann Lee", email: "a@example.test" }).includes("\r\n "), false, "a short card has no fold");
});

test("a card is bare when nothing but FN, N, UID, VERSION, PRODID and REV is left", () => {
	assert.equal(isBareCard(buildCard({ uid: "u", name: "Ann Lee", email: "a@example.test" }).replace("EMAIL;TYPE=INTERNET:a@example.test\r\n", "")), true);
	assert.equal(isBareCard("BEGIN:VCARD\r\nVERSION:4.0\r\nUID:u\r\nFN:A\r\nN:;A;;;\r\nREV:2026\r\nPRODID:x\r\nEND:VCARD\r\n"), true);
	for (const extra of ["TEL;type=CELL:+1 555 0100", "EMAIL:b@example.test", "EMAIL:not an address", "item1.EMAIL:b@example.test", "X-CUSTOM:1", "NOTE:hi", "KIND:group", "garbage without a colon"]) {
		assert.equal(isBareCard(`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u\r\nFN:A\r\n${extra}\r\nEND:VCARD\r\n`), false, extra);
	}
});

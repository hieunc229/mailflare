import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-contact-plan-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { p: join(root, "src/lib/contacts/import-store-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { planContactImport, readContactImportBody, parseContactImportCards, MAX_REQUEST_ITEMS, MAX_REQUEST_ADDRESSES, CONTACTS_PER_INSERT, DETAILS_PER_INSERT, chunk } = await import(pathToFileURL(join(dir, "p.mjs")).href);

const USER = "usr_1";
const id = (email) => `${USER}:${email}`;
const card = (name, emails, details = {}, hasPhoto = false) => ({ contact: { name, emails, details }, hasPhoto });
const plan = (cards, existing = {}, existingDetails = {}, ownAddresses = undefined) => planContactImport({
	userId: USER, cards, ownAddresses, now: new Date(1_700_000_000_000),
	existing: new Map(Object.entries(existing).map(([email, value]) => [id(email), value])),
	existingDetails: new Map(Object.entries(existingDetails).map(([email, value]) => [id(email), value])),
});

test("a new card creates an import contact per address, with the card's details and the primary photo target", () => {
	const result = plan([card("Jane Doe", ["Jane@Example.com", "j@work.co"], { organization: "Acme" }, true)]);
	assert.equal(result.created, 2);
	assert.deepEqual(result.contacts.map((row) => [row.id, row.email, row.displayName, row.source]), [[id("jane@example.com"), "jane@example.com", "Jane Doe", "import"], [id("j@work.co"), "j@work.co", "Jane Doe", "import"]]);
	assert.equal(result.detailInserts.length, 2);
	assert.deepEqual(JSON.parse(result.detailInserts[0].details), { emails: ["jane@example.com", "j@work.co"], organization: "Acme" });
	assert.deepEqual(result.photoTargets, ["jane@example.com"]);
});

test("an existing manual name is kept, an inbound name is replaced, blocked is never part of the plan", () => {
	const result = plan([card("Imported", ["a@x.co"]), card("Imported", ["b@x.co"])], {
		"a@x.co": { displayName: "Mine", source: "manual", avatarKey: null },
		"b@x.co": { displayName: "Learned", source: "inbound", avatarKey: null },
	});
	assert.equal(result.contacts.length, 0);
	assert.deepEqual(result.renames, [{ id: id("b@x.co"), displayName: "Imported", source: "import" }]);
	assert.equal(result.created, 0);
	assert.equal(result.updated, 1);
	assert.equal(result.unchanged, 1);
	for (const row of [...result.renames, ...result.contacts]) assert.ok(!("blocked" in row) && !("remoteContentAllowed" in row));
});

test("details replace the stored row when they differ and leave it alone when they match, so a re-import changes nothing", () => {
	const first = plan([card("J", ["a@x.co"], { organization: "Acme" })]);
	const stored = first.detailInserts[0].details;
	const again = plan([card("J", ["a@x.co"], { organization: "Acme" })], { "a@x.co": { displayName: "J", source: "manual", avatarKey: null } }, { "a@x.co": stored });
	assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 1]);
	assert.equal(again.contacts.length + again.renames.length + again.detailInserts.length + again.detailUpdates.length, 0);
	const changed = plan([card("J", ["a@x.co"], { organization: "Other" })], { "a@x.co": { displayName: "J", source: "manual", avatarKey: null } }, { "a@x.co": stored });
	assert.equal(changed.detailUpdates.length, 1);
	assert.deepEqual(JSON.parse(changed.detailUpdates[0].details), { emails: ["a@x.co"], organization: "Other" });
	assert.equal(changed.updated, 1);
});

test("a card with nothing but one address writes no details row and does not erase existing details", () => {
	assert.equal(plan([card("J", ["a@x.co"])]).detailInserts.length, 0);
	const kept = plan([card("J", ["a@x.co"])], { "a@x.co": { displayName: "J", source: "manual", avatarKey: null } }, { "a@x.co": '{"organization":"Acme"}' });
	assert.equal(kept.detailUpdates.length + kept.detailInserts.length, 0);
});

test("cards without a usable address are counted, not stored", () => {
	const result = plan([card("No Mail", []), card("Bad", ["not an address", "Name <x@y.co>"]), card("Ok", ["ok@x.co"])]);
	assert.equal(result.noEmail, 2);
	assert.equal(result.created, 1);
});

test("a re-import updates a name it set earlier but never one the user edited", () => {
	const result = plan([card("New Name", ["a@x.co"]), card("New Name", ["b@x.co"])], {
		"a@x.co": { displayName: "Old Name", source: "import", avatarKey: null },
		"b@x.co": { displayName: "Edited By Me", source: "manual", avatarKey: null },
	});
	assert.deepEqual(result.renames, [{ id: id("a@x.co"), displayName: "New Name", source: "import" }]);
});

test("a re-import merges details: phones and addresses are united, a missing note, birthday or organization is kept", () => {
	const stored = JSON.stringify({ emails: ["a@x.co"], phones: [{ type: "cell", value: "+1 555 0100" }], addresses: [{ type: "home", formatted: "1 Main St" }], organization: "Acme", birthday: "1980-05-01", note: "keep" });
	const result = plan([card("J", ["a@x.co"], { phones: [{ type: "work", value: "+1 (555) 0100" }, { type: "work", value: "+1 555 0199" }], addresses: [{ type: "work", formatted: "2 Side St" }] })],
		{ "a@x.co": { displayName: "J", source: "import", avatarKey: null } }, { "a@x.co": stored });
	assert.equal(result.detailUpdates.length, 1);
	assert.deepEqual(JSON.parse(result.detailUpdates[0].details), {
		emails: ["a@x.co"], phones: [{ type: "cell", value: "+1 555 0100" }, { type: "work", value: "+1 555 0199" }],
		addresses: [{ type: "home", formatted: "1 Main St" }, { type: "work", formatted: "2 Side St" }], organization: "Acme", birthday: "1980-05-01", note: "keep",
	});
	const again = plan([card("J", ["a@x.co"], { phones: [{ type: "cell", value: "+1 555 0100" }] })], { "a@x.co": { displayName: "J", source: "import", avatarKey: null } }, { "a@x.co": stored });
	assert.equal(again.detailUpdates.length, 0, "a card that adds nothing changes nothing");
});

test("the user's own identity addresses are never photo targets", () => {
	const result = plan([card("Me", ["me@own.test"], {}, true), card("Pal", ["pal@x.co"], {}, true)], {}, {}, new Set(["me@own.test"]));
	assert.deepEqual(result.photoTargets, ["pal@x.co"]);
	assert.equal(result.created, 2, "the contact rows are still written");
});

test("the same address on two cards in one request is one contact, the later card's details win", () => {
	const result = plan([card("One", ["a@x.co"], { organization: "First" }), card("Two", ["a@x.co"], { organization: "Second" })]);
	assert.equal(result.created, 1);
	assert.equal(result.contacts[0].displayName, "Two");
	assert.equal(JSON.parse(result.detailInserts[0].details).organization, "Second");
});

test("photo targets skip contacts that already have a picture and cards without a photo", () => {
	const result = plan([card("A", ["a@x.co"], {}, true), card("B", ["b@x.co"], {}, true), card("C", ["c@x.co"], {}, false)], {
		"a@x.co": { displayName: "A", source: "manual", avatarKey: "avatars/a" },
	});
	assert.deepEqual(result.photoTargets, ["b@x.co"]);
});

test("a request is capped in addresses, so one card cannot fan out into thousands of rows", () => {
	const wide = Array.from({ length: 21 }, (_, n) => card("W", Array.from({ length: 20 }, (_, m) => `u${n}m${m}@x.co`)));
	assert.throws(() => plan(wide), /Too many/);
	assert.ok(MAX_REQUEST_ADDRESSES >= 100);
});

test("inserts stay under 100 bound parameters", () => {
	assert.ok(CONTACTS_PER_INSERT * 10 <= 100);
	assert.ok(DETAILS_PER_INSERT * 3 <= 100);
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("the body: vCard items or CSV rows, with caps", () => {
	const ok = readContactImportBody({ mailboxId: "m1", format: "vcard", items: [{ vcard: "BEGIN:VCARD\nEND:VCARD", hasPhoto: true }] });
	assert.equal(ok.value.mailboxId, "m1");
	assert.equal(ok.value.items.length, 1);
	assert.ok(readContactImportBody({ mailboxId: "m1", format: "google-csv", csv: { header: ["Name"], rows: [["x"]] } }).value);
	const bad = [
		null, "x", {}, { mailboxId: 5, format: "vcard", items: [] },
		{ mailboxId: "m1", format: "vcf", items: [{ vcard: "x", hasPhoto: false }] },
		{ mailboxId: "m1", format: "vcard", items: [] },
		{ mailboxId: "m1", format: "vcard", items: Array.from({ length: MAX_REQUEST_ITEMS + 1 }, () => ({ vcard: "x", hasPhoto: false })) },
		{ mailboxId: "m1", format: "vcard", items: [{ vcard: 5, hasPhoto: false }] },
		{ mailboxId: "m1", format: "vcard", items: [{ vcard: "x".repeat(200_000), hasPhoto: false }] },
		{ mailboxId: "m1", format: "vcard", items: [{ vcard: "x", hasPhoto: "yes" }] },
		{ mailboxId: "m1", format: "vcard", csv: { header: ["Name"], rows: [["x"]] } },
		{ mailboxId: "m1", format: "google-csv", items: [{ vcard: "x", hasPhoto: false }] },
		{ mailboxId: "m1", format: "google-csv", csv: { header: Array(201).fill("a"), rows: [["x"]] } },
		{ mailboxId: "m1", format: "google-csv", csv: { header: ["Name"], rows: Array.from({ length: MAX_REQUEST_ITEMS + 1 }, () => ["x"]) } },
		{ mailboxId: "m1", format: "google-csv", csv: { header: ["Name"], rows: [[5]] } },
		{ mailboxId: "m1", format: "google-csv", csv: { header: ["Name"], rows: [["x".repeat(20_000)]] } },
		{ mailboxId: "m1", format: "google-csv", csv: { header: ["Name"], rows: [] } },
	];
	for (const body of bad) assert.ok(readContactImportBody(body).error, JSON.stringify(body)?.slice(0, 80));
});

test("cards are parsed from vCard text or CSV rows with the file's header", () => {
	const vcard = parseContactImportCards({ mailboxId: "m", format: "vcard", items: [{ vcard: "BEGIN:VCARD\nFN:Jane\nEMAIL:j@x.co\nEND:VCARD", hasPhoto: true }] });
	assert.deepEqual(vcard.map((item) => [item.contact.name, item.contact.emails, item.hasPhoto]), [["Jane", ["j@x.co"], true]]);
	const csv = parseContactImportCards({ mailboxId: "m", format: "google-csv", csv: { header: ["Name", "E-mail 1 - Value"], rows: [["Jane", "j@x.co"], ["Bob", "b@x.co"]] } });
	assert.deepEqual(csv.map((item) => [item.contact.name, item.contact.emails, item.hasPhoto]), [["Jane", ["j@x.co"], false], ["Bob", ["b@x.co"], false]]);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-contacts-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export {
				parseContactsLimit,
				CONTACTS_LIST_DEFAULT_LIMIT,
				CONTACTS_LIST_MAX_LIMIT,
				listContacts,
				saveManualContact,
			} from "./src/app/api/contacts/utils.ts";
			export { filterContactSuggestions, formatContactSuggestion } from "./src/components/compose/recipient-suggestions-utils.ts";
			export { mergeRecipients } from "./src/components/compose/recipient-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "contacts-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const {
	SqliteDatabase,
	applyMigrations,
	getDb,
	parseContactsLimit,
	CONTACTS_LIST_DEFAULT_LIMIT,
	CONTACTS_LIST_MAX_LIMIT,
	listContacts,
	saveManualContact,
	filterContactSuggestions,
	formatContactSuggestion,
	mergeRecipients,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("the contacts list defaults to a bounded page of results", () => {
	assert.equal(parseContactsLimit(null), CONTACTS_LIST_DEFAULT_LIMIT);
	assert.equal(parseContactsLimit(""), CONTACTS_LIST_DEFAULT_LIMIT);
});

test("the contacts list limit is an explicit positive number, clamped to the max", () => {
	assert.equal(parseContactsLimit("8"), 8);
	assert.equal(parseContactsLimit("25"), 25);
	assert.equal(parseContactsLimit("99999"), CONTACTS_LIST_MAX_LIMIT);
});

test("junk limit values fall back to the default instead of erroring", () => {
	for (const value of ["abc", "0", "-3", "1.5x", " "]) {
		assert.equal(parseContactsLimit(value), CONTACTS_LIST_DEFAULT_LIMIT, value);
	}
});

const contact = (email, fields = {}) => ({
	email,
	displayName: null,
	hasAvatar: false,
	blocked: false,
	...fields,
});

test("suggestions drop blocked contacts and addresses already in the chips", () => {
	const suggestions = [
		contact("kept@example.com"),
		contact("blocked@example.com", { blocked: true }),
		contact("picked@example.com"),
		contact("also-kept@example.com"),
	];
	const filtered = filterContactSuggestions(suggestions, ['"Person" <PICKED@example.com>']);
	assert.deepEqual(
		filtered.map((entry) => entry.email),
		["kept@example.com", "also-kept@example.com"],
	);
});

test("suggestions never repeat the same address twice", () => {
	const suggestions = [contact("a@example.com"), contact("A@example.com", { displayName: "A" })];
	assert.equal(filterContactSuggestions(suggestions, []).length, 1);
});

test("a picked suggestion becomes a header-formatted address", () => {
	assert.equal(formatContactSuggestion(contact("plain@example.com")), "plain@example.com");
	assert.equal(
		formatContactSuggestion(contact("named@example.com", { displayName: "Named User" })),
		'"Named User" <named@example.com>',
	);
});

test("mergeRecipients appends contacts without duplicating addresses", () => {
	assert.deepEqual(
		mergeRecipients(["existing@example.com"], ["new@example.com", "EXISTING@example.com"]),
		["existing@example.com", "new@example.com"],
	);
	assert.deepEqual(
		mergeRecipients([], ['"Ada" <ada@example.com>']),
		['"Ada" <ada@example.com>'],
	);
});

async function contactsFixture(t, rows = []) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1),
			('other', 'other@two.test', 'hash', 'Other', 'user', 1);
	`);
	const insert = database.db.prepare(`
		INSERT INTO contacts (id, user_id, email, display_name, source, blocked, last_seen_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const row of rows) insert.run(...row);
	return getDb({ DB: database });
}

const CONTACT_ROWS = [
	["c1", "owner", "zoe@example.com", "Zoe", "manual", 0, null, 1],
	["c2", "owner", "ada@example.com", "Ada", "inbound", 0, null, 1],
	["c3", "owner", "noname@example.com", null, "outbound", 0, null, 1],
	["c4", "owner", "ben@example.com", "Ben", "inbound", 1, null, 1],
	["c5", "other", "ada@example.com", "Stranger Ada", "manual", 0, null, 1],
];

test("listContacts returns the owner's contacts alphabetically by name, address breaks ties", async (t) => {
	const db = await contactsFixture(t, CONTACT_ROWS);
	const rows = await listContacts(db, { userId: "owner", query: "", limit: 100 });
	assert.deepEqual(
		rows.map((row) => row.email),
		["ada@example.com", "ben@example.com", "noname@example.com", "zoe@example.com"],
	);
});

test("listContacts searches name and address case-insensitively and never leaves the owner", async (t) => {
	const db = await contactsFixture(t, CONTACT_ROWS);
	const byName = await listContacts(db, { userId: "owner", query: "ADA" });
	assert.deepEqual(byName.map((row) => row.email), ["ada@example.com"]);
	const byAddress = await listContacts(db, { userId: "owner", query: "noname@example" });
	assert.deepEqual(byAddress.map((row) => row.email), ["noname@example.com"]);
});

test("listContacts treats LIKE wildcards in the query as literal characters", async (t) => {
	const db = await contactsFixture(t, CONTACT_ROWS);
	const escaped = await listContacts(db, { userId: "owner", query: "%@example.com" });
	assert.equal(escaped.length, 0);
});

test("saveManualContact creates then renames without duplicating the address", async (t) => {
	const db = await contactsFixture(t);
	const created = await saveManualContact(db, { userId: "owner", email: "new@example.com", displayName: "New" });
	assert.equal(created.email, "new@example.com");
	assert.equal(created.displayName, "New");
	assert.equal(created.source, "manual");

	const renamed = await saveManualContact(db, { userId: "owner", email: "new@example.com", displayName: "Renamed" });
	assert.equal(renamed.id, created.id);
	assert.equal(renamed.displayName, "Renamed");

	const kept = await saveManualContact(db, { userId: "owner", email: "new@example.com" });
	assert.equal(kept.displayName, "Renamed", "omitting the name keeps the existing one");

	const rows = await listContacts(db, { userId: "owner", query: "", limit: 100 });
	assert.equal(rows.length, 1);
});

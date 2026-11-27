import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dav-contacts-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest } from "./src/lib/dav/handler.ts";
			export { clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { mirrorContactSaved, mirrorContactDeleted } from "./src/lib/dav/contact-hooks.ts";
			export { seedStep, runContactSeeding, SEED_CHUNK, clearSeedingCache } from "./src/lib/dav/contact-seed.ts";
		`,
		resolveDir: root,
		sourcefile: "dav-contacts-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, SqliteDatabase, applyMigrations, mirrorContactSaved, mirrorContactDeleted, seedStep, runContactSeeding, SEED_CHUNK, clearSeedingCache } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";
const BOOK = "/dav/addressbooks/u1/default/";

/** The database wrapped so a test can count statements and the most bound parameters one statement carried. */
function counting(database) {
	const stats = { queries: 0, maxParams: 0, maxRows: 0, beforeBatch: null, sqls: [] };
	const wrap = (statement, params = 0) => {
		const note = (result) => (Promise.resolve(result).then((rows) => void (stats.maxRows = Math.max(stats.maxRows, Array.isArray(rows) ? rows.length : Array.isArray(rows?.results) ? rows.results.length : 0)), () => {}), result);
		const count = () => (stats.queries++, (stats.maxParams = Math.max(stats.maxParams, params)));
		return {
			bind: (...values) => wrap(statement.bind(...values), values.length),
			run: () => (count(), statement.run()),
			all: () => (count(), note(statement.all())),
			raw: (options) => (count(), note(statement.raw(options))),
			first: (column) => (count(), statement.first(column)),
		};
	};
	const proxy = new Proxy(database, { get: (target, key) => (key === "prepare" ? (sql) => (stats.sqls.push(sql), wrap(target.prepare(sql))) : key === "batch" ? async (statements) => ((() => { const hook = stats.beforeBatch; stats.beforeBatch = null; hook?.(); })(), target.batch(statements)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
	return { proxy, stats };
}

async function fixture(t, { calendarEnabled = true, enabled = true, limiter, writeLimiter, scopes = '["dav"]' } = {}) {
	clearApiKeyVerificationCache();
	clearDavEnabledCache();
	clearSeedingCache();
	const database = new SqliteDatabase(":memory:");
	t.after(() => {
		database.db.close();
		clearApiKeyVerificationCache();
		clearDavEnabledCache();
	});
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const insertUser = sql.prepare("INSERT INTO users (id, email, name, password_hash, role, calendar_enabled, time_zone, created_at) VALUES (?, ?, ?, 'x', 'user', ?, ?, 1)");
	insertUser.run("u1", "u1@one.test", "User One", calendarEnabled ? 1 : 0, "Europe/Berlin");
	insertUser.run("u2", "u2@one.test", "User Two", 1, null);
	if (enabled) sql.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	const key = await generateAppPassword();
	sql.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k1', 'u1', 'phone', ?, ?, ?, 'app', ?, 1)").run(key.prefix, key.hash, key.sha256, scopes);
	const { proxy, stats } = counting(database);
	return { database, sql, key, stats, env: { DB: proxy, DAV_RATE_LIMIT: limiter, DAV_WRITE_RATE_LIMIT: writeLimiter } };
}


const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const call = (env, method, path, { key, body, headers = {} } = {}) => handleDavRequest(new Request(`${ORIGIN}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const put = (env, key, name, body, headers = {}, area = BOOK) => call(env, "PUT", `${area}${name}`, { key, body, headers: { "Content-Type": "text/vcard; charset=utf-8", ...headers } });
const get = (env, key, name, area = BOOK) => call(env, "GET", `${area}${name}`, { key });
const del = (env, key, name, headers = {}, area = BOOK) => call(env, "DELETE", `${area}${name}`, { key, headers });
const report = (env, path, key, body) => call(env, "REPORT", path, { key, body: `<?xml version="1.0"?>${body}`, headers: { Depth: "0", "Content-Type": "application/xml" } });
const NS = `xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:R="urn:ietf:params:xml:ns:carddav"`;
const hrefs = (text) => [...text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const reset = (stats) => ((stats.queries = 0), (stats.maxParams = 0), (stats.maxRows = 0), (stats.sqls = []));

const vcard = (lines = [], { version = "3.0", uid = "card-1" } = {}) => `BEGIN:VCARD\r\nVERSION:${version}\r\nUID:${uid}\r\n${lines.join("\r\n")}${lines.length ? "\r\n" : ""}END:VCARD\r\n`;
const putCard = (env, key, name, body, headers = {}) => put(env, key, name, body, headers);
const card = (sql, name) => sql.prepare("SELECT * FROM dav_cards WHERE name = ?").get(name);
const contact = (sql, email, userId = "u1") => sql.prepare("SELECT * FROM contacts WHERE user_id = ? AND email = ?").get(userId, email);
const contactsOf = (sql, userId = "u1") => sql.prepare("SELECT email FROM contacts WHERE user_id = ? ORDER BY email").all(userId).map((row) => row.email);
const addContact = (sql, email, { source = "inbound", name = null, userId = "u1", blocked = 0, cardId = null } = {}) =>
	sql.prepare("INSERT INTO contacts (id, user_id, email, display_name, avatar_key, source, blocked, last_seen_at, dav_card_id, created_at) VALUES (?, ?, ?, ?, 'avatar-1', ?, ?, 77, ?, 1)").run(`${userId}:${email}`, userId, email, name, source, blocked, cardId);

test("a PUT creates a manual contact per address, named after the card and linked to it", async (t) => {
	const { env, key, sql } = await fixture(t);
	assert.equal((await putCard(env, key, "ann.vcf", vcard(["FN:Ann Lee", "item1.EMAIL;TYPE=INTERNET:Ann@Example.test", "EMAIL:ann@work.test"]))).status, 201);
	const id = card(sql, "ann.vcf").id;
	for (const email of ["ann@example.test", "ann@work.test"]) {
		const row = contact(sql, email);
		assert.deepEqual([row.source, row.display_name, row.dav_card_id, row.blocked], ["manual", "Ann Lee", id, 0], email);
	}
	assert.equal(contactsOf(sql, "u2").length, 0);
});

test("an existing contact is promoted to manual and linked; its flags, avatar and last-seen time are untouched", async (t) => {
	const { env, key, sql } = await fixture(t);
	addContact(sql, "ann@example.test", { source: "inbound", name: "Spam Name", blocked: 1 });
	await putCard(env, key, "ann.vcf", vcard(["FN:Ann Lee", "EMAIL:ann@example.test"]));
	const row = contact(sql, "ann@example.test");
	assert.deepEqual([row.source, row.display_name, row.dav_card_id, row.blocked, row.avatar_key, row.last_seen_at], ["manual", "Ann Lee", card(sql, "ann.vcf").id, 1, "avatar-1", 77], "blocked stays blocked: the mirror never changes it");
});

test("the first card to link an address keeps it and its name; a second card does not take it", async (t) => {
	const { env, key, sql } = await fixture(t);
	await putCard(env, key, "one.vcf", vcard(["FN:First", "EMAIL:shared@example.test"], { uid: "one" }));
	await putCard(env, key, "two.vcf", vcard(["FN:Second", "EMAIL:shared@example.test", "EMAIL:other@example.test"], { uid: "two" }));
	const shared = contact(sql, "shared@example.test");
	assert.deepEqual([shared.display_name, shared.dav_card_id], ["First", card(sql, "one.vcf").id]);
	assert.deepEqual([contact(sql, "other@example.test").display_name, contact(sql, "other@example.test").dav_card_id], ["Second", card(sql, "two.vcf").id]);
});

test("an address taken off a card is unlinked and the contact stays; a replaced card renames its contacts", async (t) => {
	const { env, key, sql } = await fixture(t);
	await putCard(env, key, "ann.vcf", vcard(["FN:Ann", "EMAIL:a@example.test", "EMAIL:b@example.test"]));
	const id = card(sql, "ann.vcf").id;
	await putCard(env, key, "ann.vcf", vcard(["FN:Anna", "EMAIL:a@example.test", "EMAIL:c@example.test"]));
	assert.deepEqual([contact(sql, "a@example.test").display_name, contact(sql, "a@example.test").dav_card_id], ["Anna", id]);
	assert.deepEqual([contact(sql, "b@example.test").display_name, contact(sql, "b@example.test").dav_card_id, contact(sql, "b@example.test").source], ["Ann", null, "manual"]);
	assert.equal(contact(sql, "c@example.test").dav_card_id, id);
});

test("a name that is no name is not copied: empty, an address, or over 100 characters", async (t) => {
	const { env, key, sql } = await fixture(t);
	addContact(sql, "keep@example.test", { name: "Mailflare Name" });
	addContact(sql, "long@example.test", { name: "Short" });
	await putCard(env, key, "a.vcf", vcard(["EMAIL:keep@example.test"], { uid: "a" }));
	await putCard(env, key, "b.vcf", vcard(["EMAIL:addr@example.test"], { uid: "b" }));
	await putCard(env, key, "c.vcf", vcard([`FN:${"x".repeat(101)}`, "EMAIL:long@example.test"], { uid: "c" }));
	assert.equal(contact(sql, "keep@example.test").display_name, "Mailflare Name");
	assert.equal(contact(sql, "addr@example.test").display_name, null);
	assert.equal(contact(sql, "long@example.test").display_name, "Short");
	assert.equal(card(sql, "c.vcf").fn.length, 101, "the card itself keeps the whole name");
	assert.ok(contact(sql, "long@example.test").dav_card_id, "it is still linked");
});

test("group cards are stored but never mirrored, and a card turned into a group lets go of its contacts", async (t) => {
	const { env, key, sql } = await fixture(t);
	assert.equal((await putCard(env, key, "g.vcf", vcard(["FN:Team", "KIND:group", "EMAIL:team@example.test"], { version: "4.0", uid: "g" }))).status, 201);
	assert.equal((await putCard(env, key, "apple.vcf", vcard(["FN:Apple team", "X-ADDRESSBOOKSERVER-KIND:group", "EMAIL:apple@example.test"], { uid: "apple" }))).status, 201);
	assert.deepEqual(contactsOf(sql), []);
	await putCard(env, key, "p.vcf", vcard(["FN:Person", "EMAIL:p@example.test"], { uid: "p" }));
	assert.ok(contact(sql, "p@example.test").dav_card_id);
	await putCard(env, key, "p.vcf", vcard(["FN:Person", "KIND:group", "EMAIL:p@example.test"], { uid: "p" }));
	assert.equal(contact(sql, "p@example.test").dav_card_id, null);
});

test("deleting a card unlinks its contacts and keeps them; a card with no address mirrors nothing", async (t) => {
	const { env, key, sql } = await fixture(t);
	await putCard(env, key, "ann.vcf", vcard(["FN:Ann", "EMAIL:a@example.test"]));
	await putCard(env, key, "none.vcf", vcard(["FN:No Address"], { uid: "none" }));
	assert.deepEqual(contactsOf(sql), ["a@example.test"]);
	assert.equal((await del(env, key, "ann.vcf")).status, 204);
	const row = contact(sql, "a@example.test");
	assert.deepEqual([row.dav_card_id, row.source, row.display_name], [null, "manual", "Ann"]);
});

test("a stale PUT writes neither the card nor its contacts", async (t) => {
	const { env, key, sql } = await fixture(t);
	const first = await putCard(env, key, "ann.vcf", vcard(["FN:Ann", "EMAIL:a@example.test"]));
	await putCard(env, key, "ann.vcf", vcard(["FN:Ann Two", "EMAIL:a@example.test"]), { "If-Match": first.headers.get("ETag") });
	const refused = await putCard(env, key, "ann.vcf", vcard(["FN:Stale", "EMAIL:stale@example.test"]), { "If-Match": first.headers.get("ETag") });
	assert.equal(refused.status, 412);
	assert.deepEqual(contactsOf(sql), ["a@example.test"]);
	assert.equal(contact(sql, "a@example.test").display_name, "Ann Two");
});

test("a card with 20 addresses stays under 40 statements and 100 parameters, creating and replacing", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	const lines = (n) => ["FN:Many", ...Array.from({ length: 20 }, (_, i) => `EMAIL:m${n}-${i}@example.test`)];
	for (const n of [1, 2]) {
		reset(stats);
		const response = await putCard(env, key, "many.vcf", vcard(lines(n), { uid: "many" }));
		assert.ok([201, 204].includes(response.status));
		assert.ok(stats.queries <= 40, `${stats.queries} statements`);
		assert.ok(stats.maxParams < 100, `${stats.maxParams} parameters`);
	}
	assert.equal(contactsOf(sql).length, 40);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM contacts WHERE dav_card_id IS NOT NULL").get().n, 20, "the first round's addresses were unlinked");
	reset(stats);
	assert.equal((await del(env, key, "many.vcf")).status, 204);
	assert.ok(stats.queries <= 40);
});

test("every mirrored card write is in the change log", async (t) => {
	const { env, key, sql } = await fixture(t);
	await putCard(env, key, "ann.vcf", vcard(["FN:Ann", "EMAIL:a@example.test"]));
	await putCard(env, key, "ann.vcf", vcard(["FN:Anna", "EMAIL:a@example.test"]));
	await del(env, key, "ann.vcf");
	const log = sql.prepare("SELECT change_type FROM dav_changes WHERE collection_id = 'card:u1' ORDER BY seq").all().map((row) => row.change_type);
	assert.deepEqual(log, ["created", "updated", "destroyed"]);
});

test("DAV never renames the account: a card listing the owner's addresses changes neither the account nor those contacts, and the other addresses are mirrored", async (t) => {
	const { env, key, sql } = await fixture(t);
	sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'one.test', 'manual', 'active', 1)").run();
	sql.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, use_all_domains, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 'personal', 0, 1)").run();
	sql.prepare("INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, created_at) VALUES ('a1', 'm1', 'd1', 'sales', 1)").run();
	addContact(sql, "u1@one.test", { source: "manual", name: "User One" });
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, seeded_at, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 1, 1, 1)").run();
	await putCard(env, key, "other.vcf", vcard(["FN:Somebody Else", "EMAIL:other@example.test"], { uid: "other" }));
	await putCard(env, key, "me.vcf", vcard(["FN:Me Renamed", "EMAIL:u1@one.test", "EMAIL:Sales@one.test", "EMAIL:me2@example.test"], { uid: "me" }));
	assert.equal(sql.prepare("SELECT name FROM users WHERE id = 'u1'").get().name, "User One", "the account keeps its name");
	assert.equal(sql.prepare("SELECT count(*) AS n FROM mailboxes WHERE display_name IS NOT NULL").get().n, 0);
	assert.deepEqual([contact(sql, "u1@one.test").display_name, contact(sql, "u1@one.test").dav_card_id], ["User One", null], "the owner's address is not renamed or linked");
	assert.equal(contact(sql, "sales@one.test"), undefined, "an alias is not made a contact by the mirror");
	assert.deepEqual([contact(sql, "me2@example.test").display_name, contact(sql, "me2@example.test").dav_card_id], ["Me Renamed", card(sql, "me.vcf").id]);
});

// ---- Mailflare-side edits (the Contacts API hooks) ----

/** A fixture whose user already has an address book (their phone made the first CardDAV request, and seeding is over). */
async function bookFixture(t, options) {
	const made = await fixture(t, options);
	made.sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, seeded_at, seed_started_at, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 1, 1, 1, 1)").run();
	return made;
}

const saved = (sql, email, name, { source = "manual" } = {}) => {
	sql.prepare("INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES (?, 'u1', ?, ?, ?, 1) ON CONFLICT (user_id, email) DO UPDATE SET display_name = excluded.display_name, source = excluded.source").run(`u1:${email}`, email, name, source);
	return sql.prepare("SELECT id, email, display_name AS displayName, dav_card_id AS davCardId FROM contacts WHERE id = ?").get(`u1:${email}`);
};
const cardRows = (sql) => sql.prepare("SELECT * FROM dav_cards ORDER BY name").all();
const logOf = (sql) => sql.prepare("SELECT object_key AS key, change_type AS type FROM dav_changes WHERE collection_id = 'card:u1' ORDER BY seq").all();
const phone = (extra = []) => vcard(["N:Lee;Ann;Marie;Dr.;PhD", "FN:Dr. Ann Lee", "item1.EMAIL;type=INTERNET:ann@example.test", "item1.X-ABLabel:work", "EMAIL:ann@work.test", "TEL;type=CELL:+1 555 0100", "PHOTO;ENCODING=b;TYPE=JPEG:AAAA", "X-CUSTOM:kept", ...extra], { uid: "phone-1" });

test("a contact created in Mailflare becomes a 3.0 card the phone can read, linked to it", async (t) => {
	const { env, key, sql } = await bookFixture(t);
	const contactRow = saved(sql, "ann@example.test", "Ann Marie Lee");
	await mirrorContactSaved(env, "u1", contactRow);
	const [row] = cardRows(sql);
	assert.equal(cardRows(sql).length, 1);
	assert.equal(row.version, "3.0");
	assert.ok(row.uid.startsWith("mf-") && row.name === `${row.uid}.vcf`);
	assert.ok(row.body.includes("PRODID:-//Mailflare//Contacts//EN") && row.body.includes("FN:Ann Marie Lee") && row.body.includes("N:Lee;Ann Marie;;;") && row.body.includes("EMAIL;TYPE=INTERNET:ann@example.test"));
	assert.equal(sql.prepare("SELECT dav_card_id FROM contacts WHERE id = ?").get(contactRow.id).dav_card_id, row.id);
	assert.deepEqual(logOf(sql), [{ key: row.id, type: "created" }]);
	const fetched = await get(env, key, row.name, BOOK);
	assert.equal(await fetched.text(), row.body);
});

test("a contact without a name gets a card named after its address and keeps no name", async (t) => {
	const { env, sql } = await bookFixture(t);
	await mirrorContactSaved(env, "u1", saved(sql, "who@example.test", null));
	assert.ok(cardRows(sql)[0].body.includes("FN:who@example.test"));
	assert.equal(contact(sql, "who@example.test").display_name, null);
});

test("a rename rewrites FN and N of the linked card and keeps what the phone stored; the other address follows the name", async (t) => {
	const { env, key, sql } = await bookFixture(t);
	await putCard(env, key, "ann.vcf", phone());
	const before = card(sql, "ann.vcf");
	const etagBefore = (await get(env, key, "ann.vcf", BOOK)).headers.get("ETag");
	await mirrorContactSaved(env, "u1", saved(sql, "ann@example.test", "Anna Lee"));
	const after = card(sql, "ann.vcf");
	const bodyLines = (body) => body.split("\r\n");
	assert.deepEqual(
		bodyLines(before.body).filter((line) => !bodyLines(after.body).includes(line)),
		["N:Lee;Ann;Marie;Dr.;PhD", "FN:Dr. Ann Lee"],
	);
	assert.deepEqual(bodyLines(after.body).filter((line) => !bodyLines(before.body).includes(line)), ["N:Lee;Anna;;;", "FN:Anna Lee"]);
	assert.equal(after.fn, "Anna Lee");
	assert.equal(contact(sql, "ann@work.test").display_name, "Anna Lee");
	assert.deepEqual(logOf(sql).map((row) => row.type), ["created", "updated"]);
	assert.notEqual((await get(env, key, "ann.vcf", BOOK)).headers.get("ETag"), etagBefore, "the phone sees a new ETag");
});

test("renaming to the name the card already has writes nothing", async (t) => {
	const { env, key, sql, stats } = await bookFixture(t);
	await putCard(env, key, "ann.vcf", phone());
	const rowCount = logOf(sql).length;
	await mirrorContactSaved(env, "u1", saved(sql, "ann@example.test", "Dr. Ann Lee"));
	assert.equal(logOf(sql).length, rowCount);
	reset(stats);
	await mirrorContactSaved(env, "u1", saved(sql, "ann@example.test", "Dr. Ann Lee"));
	assert.equal(logOf(sql).length, rowCount);
});

test("a phone edit between the read and the write is never overwritten: the rename is redone on the new card", async (t) => {
	const { env, key, sql, stats } = await bookFixture(t);
	await putCard(env, key, "ann.vcf", phone());
	stats.beforeBatch = () => {
		const edited = card(sql, "ann.vcf").body.replace("END:VCARD", "TEL;type=HOME:+1 555 0199\r\nEND:VCARD");
		sql.prepare("UPDATE dav_cards SET body = ?, size = ? WHERE name = 'ann.vcf'").run(edited, edited.length);
	};
	await mirrorContactSaved(env, "u1", saved(sql, "ann@example.test", "Anna Lee"));
	const body = card(sql, "ann.vcf").body;
	assert.ok(body.includes("TEL;type=HOME:+1 555 0199"), "the phone's concurrent edit survives");
	assert.ok(body.includes("FN:Anna Lee"), "and the rename still lands");
});

test("deleting a contact deletes a card that has only its address, and unlinks nothing else", async (t) => {
	const { env, sql } = await bookFixture(t);
	await mirrorContactSaved(env, "u1", saved(sql, "ann@example.test", "Ann"));
	await mirrorContactSaved(env, "u1", saved(sql, "bob@example.test", "Bob"));
	const ann = contact(sql, "ann@example.test");
	await mirrorContactDeleted(env, "u1", { email: "ann@example.test", davCardId: ann.dav_card_id });
	assert.equal(cardRows(sql).length, 1);
	assert.equal(contact(sql, "bob@example.test").dav_card_id, cardRows(sql)[0].id);
	assert.deepEqual(logOf(sql).map((row) => row.type), ["created", "created", "destroyed"]);
});

test("deleting a contact on a card with other addresses removes only its EMAIL line", async (t) => {
	const { env, key, sql } = await bookFixture(t);
	await putCard(env, key, "ann.vcf", phone());
	const before = card(sql, "ann.vcf");
	assert.equal(await mirrorContactDeleted(env, "u1", { email: "ann@example.test", davCardId: before.id }), true);
	const after = card(sql, "ann.vcf");
	assert.deepEqual(
		before.body.split("\r\n").filter((line) => !after.body.split("\r\n").includes(line)),
		["item1.EMAIL;type=INTERNET:ann@example.test", "item1.X-ABLabel:work"],
	);
	assert.deepEqual(JSON.parse(after.emails), ["ann@work.test"]);
	assert.equal(contact(sql, "ann@work.test").dav_card_id, before.id);
	assert.equal(contact(sql, "ann@example.test").dav_card_id, null, "its own link is gone (the route deletes the contact row itself)");
	assert.deepEqual(logOf(sql).map((row) => row.type), ["created", "updated"]);
});

test("a card that holds anything beyond FN, N, EMAIL, UID, VERSION, PRODID and REV keeps it: only the EMAIL line goes, and the card stays", async (t) => {
	const { env, key, sql } = await bookFixture(t);
	for (const extra of ["TEL;type=CELL:+1 555 0100", "X-CUSTOM:kept", "NOTE:hello", "PHOTO;ENCODING=b;TYPE=JPEG:AAAA"]) {
		const name = `${extra.slice(0, 3).toLowerCase()}.vcf`;
		const address = `${extra.slice(0, 3).toLowerCase()}@example.test`;
		await putCard(env, key, name, vcard(["FN:Ann", `EMAIL:${address}`, extra], { uid: name }));
		const before = card(sql, name);
		assert.equal(await mirrorContactDeleted(env, "u1", { email: address, davCardId: before.id }), true, extra);
		const after = card(sql, name);
		assert.ok(after, `${extra}: the card stays`);
		assert.ok(after.body.includes(extra) && !after.body.includes("EMAIL"), extra);
		assert.deepEqual(JSON.parse(after.emails), []);
		assert.equal(contact(sql, address).dav_card_id, null);
	}
});

test("a card with a second EMAIL line, valid or not, keeps it and the card", async (t) => {
	const { env, key, sql } = await bookFixture(t);
	await putCard(env, key, "two.vcf", vcard(["FN:Two", "EMAIL:one@example.test", "EMAIL:not an address"], { uid: "two" }));
	const before = card(sql, "two.vcf");
	assert.deepEqual(JSON.parse(before.emails), ["one@example.test"], "only the valid one is a contact");
	assert.equal(await mirrorContactDeleted(env, "u1", { email: "one@example.test", davCardId: before.id }), true);
	assert.ok(card(sql, "two.vcf").body.includes("EMAIL:not an address"));
	assert.ok(!card(sql, "two.vcf").body.includes("one@example.test"));
});

test("a card that is only a name and the deleted address goes", async (t) => {
	const { env, key, sql } = await bookFixture(t);
	await putCard(env, key, "bare.vcf", vcard(["FN:Bare", "N:;Bare;;;", "REV:2026-01-01", "PRODID:-//x//EN", "EMAIL:bare@example.test"], { uid: "bare" }));
	assert.equal(await mirrorContactDeleted(env, "u1", { email: "bare@example.test", davCardId: card(sql, "bare.vcf").id }), true);
	assert.equal(card(sql, "bare.vcf"), undefined);
});

test("when the card cannot be changed the delete reports it, so the route keeps the contact", async (t) => {
	const { env, key, sql, stats } = await bookFixture(t);
	await putCard(env, key, "ann.vcf", phone());
	const id = card(sql, "ann.vcf").id;
	// A phone keeps writing the card between every read and write: the guard fails each time.
	const interfere = () => {
		const edited = `${card(sql, "ann.vcf").body.replace("END:VCARD", "X-N:1\r\nEND:VCARD")}`;
		sql.prepare("UPDATE dav_cards SET body = ?, size = ? WHERE name = 'ann.vcf'").run(edited, edited.length);
		stats.beforeBatch = interfere;
	};
	stats.beforeBatch = interfere;
	assert.equal(await mirrorContactDeleted(env, "u1", { email: "ann@example.test", davCardId: id }), false);
	stats.beforeBatch = null;
	assert.ok(card(sql, "ann.vcf").body.includes("ann@example.test"), "the card still lists it");
	assert.equal(await mirrorContactDeleted(env, "u1", { email: "ann@example.test", davCardId: id }), true, "a later try works");
});

test("a contact nobody linked, a user without an address book and an address that cannot be on a card change nothing", async (t) => {
	const { env, key, sql } = await fixture(t);
	assert.equal(await mirrorContactDeleted(env, "u1", { email: "free@example.test", davCardId: null }), true);
	await mirrorContactSaved(env, "u1", saved(sql, "ann@example.test", "Ann"));
	assert.equal(cardRows(sql).length, 0, "no address book yet: nothing is written");
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_changes").get().n, 0);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_collections").get().n, 0, "and no address book is made");
	await propfind(env, key);
	const carded = cardRows(sql).length;
	await mirrorContactSaved(env, "u1", saved(sql, "odd,addr@example.test", "Odd"));
	assert.equal(cardRows(sql).length, carded, "an address a card cannot hold gets none");
});

test("a user without an address book costs one read per contact edit and no write", async (t) => {
	const { env, sql, stats } = await fixture(t, { enabled: false });
	const row = saved(sql, "ann@example.test", "Ann");
	reset(stats);
	await mirrorContactSaved(env, "u1", row);
	await mirrorContactDeleted(env, "u1", { email: row.email, davCardId: "card_x" });
	assert.equal(stats.queries, 2, `${stats.queries} statements`);
	assert.ok(stats.sqls.every((statement) => /^select/i.test(statement)), stats.sqls.join(" | "));
});

test("the sides stay in step while the switch is off: a rename and a new contact reach the address book, and are there when it is on again", async (t) => {
	const { env, key, sql } = await fixture(t);
	await propfind(env, key);
	await putCard(env, key, "ann.vcf", phone());
	sql.prepare("UPDATE app_settings SET dav_enabled = 0 WHERE id = 'default'").run();
	clearDavEnabledCache();
	assert.equal((await propfind(env, key)).status, 404, "DAV itself is off");
	await mirrorContactSaved(env, "u1", saved(sql, "ann@example.test", "Anna Lee"));
	await mirrorContactSaved(env, "u1", saved(sql, "new@example.test", "New Person"));
	sql.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	clearDavEnabledCache();
	assert.ok((await (await get(env, key, "ann.vcf")).text()).includes("FN:Anna Lee"), "the card has the new name");
	assert.equal(cardRows(sql).length, 2);
	assert.ok(cardRows(sql).some((row) => row.body.includes("FN:New Person")), "and the new contact has its card");
});

test("a contact for one of the owner's own addresses gets no card, however often it is saved", async (t) => {
	const { env, sql } = await bookFixture(t);
	sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'one.test', 'manual', 'active', 1)").run();
	sql.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, use_all_domains, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 'personal', 0, 1)").run();
	for (const name of ["Me", "Me Again", "Me Third"]) await mirrorContactSaved(env, "u1", saved(sql, "u1@one.test", name));
	assert.equal(cardRows(sql).length, 0);
});

test("a link to a card that no longer exists is replaced by a new card", async (t) => {
	const { env, sql } = await bookFixture(t);
	const row = saved(sql, "ann@example.test", "Ann");
	sql.prepare("UPDATE contacts SET dav_card_id = 'card_gone' WHERE id = ?").run(row.id);
	await mirrorContactSaved(env, "u1", { ...row, davCardId: "card_gone" });
	assert.equal(cardRows(sql).length, 1);
	assert.equal(contact(sql, "ann@example.test").dav_card_id, cardRows(sql)[0].id);
});

test("two saves of the same new contact at once make one card", async (t) => {
	const { env, sql } = await bookFixture(t);
	const row = saved(sql, "ann@example.test", "Ann");
	await Promise.all([mirrorContactSaved(env, "u1", row), mirrorContactSaved(env, "u1", row)]);
	assert.equal(cardRows(sql).length, 1);
	assert.equal(contact(sql, "ann@example.test").dav_card_id, cardRows(sql)[0].id);
});

test("the quotas hold for Mailflare-made cards too: 5000 cards, 20 MB; the contact is saved either way", async (t) => {
	const { env, sql } = await bookFixture(t);
	const insert = sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES (?, 'u1', 'card:u1', ?, ?, 'b', '3.0', 1, 1, 1)");
	sql.exec("BEGIN");
	for (let i = 0; i < 5000; i++) insert.run(`c${i}`, `c${i}.vcf`, `uid${i}`);
	sql.exec("COMMIT");
	const row = saved(sql, "ann@example.test", "Ann");
	await mirrorContactSaved(env, "u1", row);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 5000);
	assert.equal(contact(sql, "ann@example.test").dav_card_id, null);
	sql.prepare("DELETE FROM dav_cards WHERE id LIKE 'c%' AND id <> 'c0'").run();
	sql.prepare("UPDATE dav_cards SET size = ? WHERE id = 'c0'").run(20 * 1024 * 1024);
	await mirrorContactSaved(env, "u1", row);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 1, "no room for another card");
});

test("a Mailflare edit stays under 40 statements and 100 parameters", async (t) => {
	const { env, key, sql, stats } = await bookFixture(t);
	await putCard(env, key, "many.vcf", vcard(["FN:Many", ...Array.from({ length: 20 }, (_, i) => `EMAIL:m${i}@example.test`)], { uid: "many" }));
	for (const run of [() => mirrorContactSaved(env, "u1", saved(sql, "m0@example.test", "Renamed")), () => mirrorContactSaved(env, "u1", saved(sql, "new@example.test", "New")), () => mirrorContactDeleted(env, "u1", { email: "m1@example.test", davCardId: card(sql, "many.vcf").id })]) {
		reset(stats);
		await run();
		assert.ok(stats.queries <= 40, `${stats.queries} statements`);
		assert.ok(stats.maxParams < 100, `${stats.maxParams} parameters`);
	}
});

// ---- seeding the address book from existing manual contacts ----

const propfind = (env, key) => call(env, "PROPFIND", BOOK, { key, headers: { Depth: "1" } });
const seededAt = (sql) => sql.prepare("SELECT seeded_at AS at FROM dav_collections WHERE id = 'card:u1'").get()?.at ?? null;
const manual = (sql, count, prefix = "p") => Array.from({ length: count }, (_, i) => addContact(sql, `${prefix}${String(i).padStart(3, "0")}@example.test`, { source: "manual", name: `Person ${i}` }));
/** One cron run is one step: the switch, the book to take, the step (contacts, own addresses, cards already there, quota, the batch). */
const CRON_STATEMENTS = 11;
const linked = (sql) => sql.prepare("SELECT count(*) AS n FROM contacts WHERE dav_card_id IS NOT NULL").get().n;

test("the first CardDAV request copies manual contacts into cards; collected addresses stay out", async (t) => {
	const { env, key, sql } = await fixture(t);
	manual(sql, 3);
	addContact(sql, "heard@example.test", { source: "inbound", name: "Heard" });
	addContact(sql, "sent@example.test", { source: "outbound" });
	addContact(sql, "u2only@example.test", { source: "manual", userId: "u2" });
	const response = await propfind(env, key);
	assert.equal(response.status, 207);
	const listed = hrefs(await response.text()).filter((href) => href.endsWith(".vcf"));
	assert.equal(listed.length, 3);
	assert.equal(cardRows(sql).length, 3);
	assert.equal(linked(sql), 3);
	assert.equal(contact(sql, "heard@example.test").dav_card_id, null);
	assert.equal(contact(sql, "u2only@example.test", "u2").dav_card_id, null);
	assert.ok(seededAt(sql));
	assert.ok(cardRows(sql).every((row) => row.version === "3.0" && row.body.includes("PRODID:-//Mailflare//Contacts//EN")));
	assert.equal(logOf(sql).filter((row) => row.type === "created").length, 3, "every seeded card is in the change log");
});

test("seeding runs once: later requests and the cron find nothing to do and write nothing", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	manual(sql, 2);
	await propfind(env, key);
	const log = logOf(sql).length;
	reset(stats);
	await propfind(env, key);
	assert.equal(logOf(sql).length, log);
	assert.equal(cardRows(sql).length, 2);
	assert.ok(!stats.sqls.some((statement) => /(insert into|update) ["`]?(dav_cards|contacts|dav_collections)/i.test(statement)), "the second request writes no card, contact or collection");
	assert.equal(await runContactSeeding(env), 0);
	manual(sql, 1, "late");
	await propfind(env, key);
	assert.equal(cardRows(sql).length, 2, "a contact added after seeding is the Contacts API hook's job, not seeding's");
});

test("a large address book is seeded in bounded steps: the request does one, the cron the rest, one card per contact", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	const total = SEED_CHUNK * 3 + 5;
	manual(sql, total);
	reset(stats);
	await propfind(env, key);
	assert.ok(stats.queries <= 40, `request: ${stats.queries} statements`);
	assert.equal(cardRows(sql).length, SEED_CHUNK, "a request does one step");
	assert.equal(seededAt(sql), null, "not finished yet");
	for (let run = 0; run < 10 && seededAt(sql) === null; run++) {
		reset(stats);
		clearDavEnabledCache();
		await runContactSeeding(env);
		assert.ok(stats.queries <= CRON_STATEMENTS, `cron: ${stats.queries} statements`);
		assert.ok(stats.maxParams < 100, `${stats.maxParams} parameters`);
	}
	assert.equal(cardRows(sql).length, total);
	assert.equal(linked(sql), total);
	assert.equal(new Set(cardRows(sql).map((row) => row.uid)).size, total);
	assert.ok(seededAt(sql));
});

test("seeding stopped halfway resumes without a second card for any contact", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	manual(sql, SEED_CHUNK + 6);
	await propfind(env, key);
	assert.equal(cardRows(sql).length, SEED_CHUNK);
	stats.beforeBatch = () => {
		stats.beforeBatch = null;
		throw new Error("connection lost");
	};
	await assert.rejects(() => seedStep(env, "u1"), /connection lost/);
	assert.equal(cardRows(sql).length, SEED_CHUNK, "the failed batch wrote nothing");
	await runContactSeeding(env);
	assert.equal(cardRows(sql).length, SEED_CHUNK + 6);
	assert.equal(new Set(sql.prepare("SELECT dav_card_id AS id FROM contacts").all().map((row) => row.id)).size, SEED_CHUNK + 6);
});

test("two seeders at once make one card per contact", async (t) => {
	const { env, sql } = await fixture(t);
	manual(sql, 10);
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 1, 1)").run();
	await Promise.all([seedStep(env, "u1"), seedStep(env, "u1")]);
	assert.equal(cardRows(sql).length, 10);
	assert.equal(linked(sql), 10);
});

test("contacts that already have a card are skipped; blocked manual contacts are seeded; an address that cannot be on a card is left alone", async (t) => {
	const { env, key, sql } = await fixture(t);
	addContact(sql, "ann@example.test", { source: "manual", name: "Ann" });
	addContact(sql, "blocked@example.test", { source: "manual", blocked: 1, name: "Blocked" });
	addContact(sql, "odd,addr@example.test", { source: "manual" });
	addContact(sql, "fine@example.test", { source: "manual" });
	// Ann is on a card already (made by another request before this user's first CardDAV request would have seeded her).
	sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('card_ann', 'u1', 'card:u1', 'ann.vcf', 'ann', 'b', '3.0', 1, 1, 1)").run();
	sql.prepare("UPDATE contacts SET dav_card_id = 'card_ann' WHERE email = 'ann@example.test'").run();
	await propfind(env, key);
	assert.equal(cardRows(sql).length, 3);
	assert.ok(contact(sql, "blocked@example.test").dav_card_id);
	assert.ok(contact(sql, "fine@example.test").dav_card_id);
	assert.equal(contact(sql, "odd,addr@example.test").dav_card_id, null);
	assert.equal(contact(sql, "blocked@example.test").blocked, 1);
	assert.ok(seededAt(sql), "finished, though one contact cannot be seeded");
});

test("seeding respects the card quota: it fills what is left, pauses, and resumes when there is room", async (t) => {
	const { env, key, sql } = await fixture(t);
	const insert = sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES (?, 'u1', 'card:u1', ?, ?, 'b', '3.0', 1, 1, 1)");
	sql.exec("BEGIN");
	for (let i = 0; i < 4999; i++) insert.run(`c${i}`, `c${i}.vcf`, `uid${i}`);
	sql.exec("COMMIT");
	manual(sql, 3);
	await propfind(env, key).then((response) => response.text());
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 5000);
	assert.equal(linked(sql), 1);
	assert.equal(seededAt(sql), null, "paused, not finished");
	clearDavEnabledCache();
	await runContactSeeding(env);
	assert.equal(linked(sql), 1, "still full: nothing more, nothing lost");
	sql.prepare("DELETE FROM dav_cards WHERE id IN ('c1', 'c2', 'c3')").run();
	await runContactSeeding(env);
	assert.equal(linked(sql), 3, "room again: the rest is seeded");
	await runContactSeeding(env);
	assert.ok(seededAt(sql));
});

test("a paused address book does not keep the others waiting", async (t) => {
	const { env, sql } = await fixture(t);
	const insert = sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES (?, 'u1', 'card:u1', ?, ?, 'b', '3.0', 1, 1, 1)");
	sql.exec("BEGIN");
	for (let i = 0; i < 5000; i++) insert.run(`c${i}`, `c${i}.vcf`, `uid${i}`);
	sql.exec("COMMIT");
	manual(sql, 2);
	manual(sql, 2, "q");
	sql.prepare("UPDATE contacts SET user_id = 'u2', id = 'u2:' || email WHERE email LIKE 'q%'").run();
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 1, 1)").run();
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, created_at, updated_at) VALUES ('card:u2', 'u2', 'addressbook', '{}', 2, 2)").run();
	clearDavEnabledCache();
	await runContactSeeding(env);
	await runContactSeeding(env);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM contacts WHERE user_id = 'u2' AND dav_card_id IS NOT NULL").get().n, 2, "the second user's contacts were seeded on the second run");
});

test("seeding does not stop at addresses a card cannot hold: they are skipped and the rest is seeded", async (t) => {
	const { env, key, sql } = await fixture(t);
	for (let i = 0; i < SEED_CHUNK + 3; i++) addContact(sql, `a,${String(i).padStart(3, "0")}@example.test`, { source: "manual" });
	for (const name of ["x1", "x2", "x3"]) addContact(sql, `${name}@example.test`, { source: "manual", name });
	await propfind(env, key);
	for (let run = 0; run < 5 && seededAt(sql) === null; run++) await runContactSeeding(env);
	assert.equal(cardRows(sql).length, 3);
	assert.equal(linked(sql), 3);
	assert.ok(seededAt(sql));
});

test("a card deleted on the phone while seeding is still going is not made again", async (t) => {
	const { env, key, sql } = await fixture(t);
	const total = SEED_CHUNK * 2 + 6;
	manual(sql, total);
	await propfind(env, key);
	const gone = cardRows(sql).find((row) => row.body.includes("FN:Person 0\r\n"));
	assert.ok(gone, "the first contact was carded");
	assert.equal((await del(env, key, gone.name)).status, 204);
	assert.equal(contact(sql, "p000@example.test").dav_card_id, null);
	for (let run = 0; run < 8 && seededAt(sql) === null; run++) await runContactSeeding(env);
	assert.ok(seededAt(sql));
	assert.equal(cardRows(sql).length, total - 1, "the others are seeded, that one is not");
	assert.equal(contact(sql, "p000@example.test").dav_card_id, null);
	assert.ok(!cardRows(sql).some((row) => row.emails.includes("p000@example.test")));
});

test("an address that is already on some card gets no second card", async (t) => {
	const { env, key, sql } = await fixture(t);
	sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, fn, emails, size, created_at, updated_at) VALUES ('card_other', 'u1', 'card:u1', 'other.vcf', 'other', 'b', '3.0', 'Other', ?, 1, 1, 1)").run(JSON.stringify(["listed@example.test", "also@example.test"]));
	addContact(sql, "listed@example.test", { source: "manual", name: "Listed" });
	addContact(sql, "fresh@example.test", { source: "manual", name: "Fresh" });
	await propfind(env, key);
	assert.equal(cardRows(sql).length, 2, "the other card and one for the new address");
	assert.equal(contact(sql, "listed@example.test").dav_card_id, null);
	assert.ok(contact(sql, "fresh@example.test").dav_card_id);
	assert.ok(seededAt(sql));
});

test("only contacts from before seeding began are seeded; later ones are the hooks' job", async (t) => {
	const { env, key, sql } = await fixture(t);
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, seed_started_at, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 100, 1, 1)").run();
	addContact(sql, "before@example.test", { source: "manual" });
	addContact(sql, "after@example.test", { source: "manual" });
	sql.prepare("UPDATE contacts SET created_at = 50 WHERE email = 'before@example.test'").run();
	sql.prepare("UPDATE contacts SET created_at = 200 WHERE email = 'after@example.test'").run();
	await propfind(env, key);
	assert.ok(contact(sql, "before@example.test").dav_card_id);
	assert.equal(contact(sql, "after@example.test").dav_card_id, null);
	assert.ok(seededAt(sql));
});

test("seeding starts when the address book is first read and never moves back", async (t) => {
	const { env, key, sql } = await fixture(t);
	manual(sql, 2);
	const before = Math.floor(Date.now() / 1000);
	await propfind(env, key);
	const row = sql.prepare("SELECT seed_started_at AS at, seed_cursor AS cursor FROM dav_collections WHERE id = 'card:u1'").get();
	assert.ok(row.at >= before && row.at <= before + 5, `seed_started_at ${row.at}`);
	assert.equal(row.cursor, "u1:p001@example.test", "the cursor is the last contact dealt with");
});

test("the owner's own addresses are not seeded: the mailbox, its aliases and its address on every domain", async (t) => {
	const { env, key, sql } = await fixture(t);
	for (const [id, host] of [["d1", "one.test"], ["d2", "two.test"]]) sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES (?, 'u1', ?, 'manual', 'active', 1)").run(id, host);
	sql.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, use_all_domains, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 'personal', 1, 1)").run();
	sql.prepare("INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, created_at) VALUES ('a1', 'm1', 'd1', 'sales', 1)").run();
	for (const email of ["u1@one.test", "sales@one.test", "u1@two.test"]) addContact(sql, email, { source: "manual", name: "User One" });
	addContact(sql, "friend@example.test", { source: "manual", name: "Friend" });
	addContact(sql, "u1@elsewhere.test", { source: "manual", name: "Namesake" });
	await propfind(env, key);
	assert.deepEqual(cardRows(sql).map((row) => JSON.parse(row.emails)).sort(), [["friend@example.test"], ["u1@elsewhere.test"]]);
	assert.equal(sql.prepare("SELECT name FROM users WHERE id = 'u1'").get().name, "User One");
	assert.ok(seededAt(sql));
});

test("only reads seed: a PUT or a DELETE writes nothing but its own card", async (t) => {
	const { env, key, sql } = await fixture(t);
	manual(sql, 3);
	assert.equal((await putCard(env, key, "ann.vcf", vcard(["FN:Ann", "EMAIL:ann@example.test"]))).status, 201);
	assert.equal(cardRows(sql).length, 1, "no seeding on a PUT");
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_collections").get().n, 0);
	assert.equal((await del(env, key, "ann.vcf")).status, 204);
	assert.equal(cardRows(sql).length, 0, "no seeding on a DELETE");
	assert.equal((await get(env, key, "nothing.vcf")).status, 404);
	assert.equal(cardRows(sql).length, 4, "a GET does: the three contacts and the one the PUT made");
});

test("a REPORT seeds too", async (t) => {
	const { env, key, sql } = await fixture(t);
	manual(sql, 2);
	assert.equal((await report(env, BOOK, key, `<R:addressbook-query ${NS}><A:prop><A:getetag/></A:prop></R:addressbook-query>`)).status, 207);
	assert.equal(cardRows(sql).length, 2);
});

test("a seeder that loses a race skips its step without retrying; the next run finishes", async (t) => {
	const { env, sql, stats } = await fixture(t);
	manual(sql, 5);
	const { createHash } = await import("node:crypto");
	const key = createHash("sha256").update("u1:p002@example.test").digest("hex").slice(0, 32);
	// Another writer takes one contact's card name just before the batch.
	stats.beforeBatch = () => sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('card_x', 'u1', 'card:u1', ?, ?, 'b', '3.0', 1, 1, 1)").run(`mf-${key}.vcf`, `mf-${key}`);
	reset(stats);
	assert.equal(await seedStep(env, "u1"), "more", "a conflict is not an error");
	assert.equal(stats.sqls.filter((statement) => /from "?`?contacts"?`?/i.test(statement) && /^select/i.test(statement)).length, 1, "one attempt");
	assert.equal(linked(sql), 0, "the failed batch wrote nothing");
	await runContactSeeding(env);
	assert.equal(linked(sql), 4, "the contact whose card is taken is left, the others are seeded");
	assert.ok(seededAt(sql));
});

test("a book whose step keeps failing does not keep the others waiting", async (t) => {
	const { env, sql, stats } = await fixture(t);
	manual(sql, 2);
	manual(sql, 2, "q");
	sql.prepare("UPDATE contacts SET user_id = 'u2', id = 'u2:' || email WHERE email LIKE 'q%'").run();
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, seed_started_at, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 100, 1, 1)").run();
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, seed_started_at, created_at, updated_at) VALUES ('card:u2', 'u2', 'addressbook', '{}', 100, 2, 2)").run();
	clearDavEnabledCache();
	stats.beforeBatch = () => {
		throw new Error("connection lost");
	};
	await assert.rejects(() => runContactSeeding(env), /connection lost/);
	await runContactSeeding(env);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM contacts WHERE user_id = 'u2' AND dav_card_id IS NOT NULL").get().n, 2, "the next run took the other book");
});

test("one cron run for a book still to seed is one step and a few statements", async (t) => {
	const { env, sql, stats } = await fixture(t);
	manual(sql, SEED_CHUNK * 2);
	sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'one.test', 'manual', 'active', 1)").run();
	sql.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 'personal', 1)").run();
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, seed_started_at, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 100, 1, 1)").run();
	clearDavEnabledCache();
	reset(stats);
	assert.equal(await runContactSeeding(env), 1);
	assert.equal(linked(sql), SEED_CHUNK, "one step");
	assert.ok(stats.queries <= CRON_STATEMENTS, `${stats.queries} statements`);
	clearDavEnabledCache();
	reset(stats);
	await runContactSeeding(env);
	assert.equal(linked(sql), SEED_CHUNK * 2);
	clearDavEnabledCache();
	reset(stats);
	assert.equal(await runContactSeeding(env), 1, "the last step finds nothing and finishes");
	assert.ok(seededAt(sql));
	clearDavEnabledCache();
	reset(stats);
	assert.equal(await runContactSeeding(env), 0);
	assert.ok(stats.queries <= 2, `a seeded user costs ${stats.queries} statements`);
});

test("with the switch off the cron seeds nothing", async (t) => {
	const { env, sql } = await fixture(t, { enabled: false });
	manual(sql, 2);
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, dead_props, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', '{}', 1, 1)").run();
	assert.equal(await runContactSeeding(env), 0);
	assert.equal(cardRows(sql).length, 0);
	assert.equal(seededAt(sql), null);
});

test("a PUT-created card is reachable in sync-collection together with the seeded ones", async (t) => {
	const { env, key, sql } = await fixture(t);
	manual(sql, 2);
	const first = await report(env, BOOK, key, `<A:sync-collection ${NS}><A:sync-token/><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`);
	assert.equal(hrefs(await first.text()).filter((href) => href.endsWith(".vcf")).length, 2, "the very first sync already carries the seeded cards");
});

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

const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

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
	const proxy = new Proxy(database, { get: (target, key) => (key === "prepare" ? (sql) => (stats.sqls.push(sql), wrap(target.prepare(sql))) : key === "batch" ? async (statements) => (stats.beforeBatch?.(), (stats.beforeBatch = null), target.batch(statements)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
	return { proxy, stats };
}

async function fixture(t, { calendarEnabled = true, enabled = true, limiter, writeLimiter, scopes = '["dav"]' } = {}) {
	clearApiKeyVerificationCache();
	clearDavEnabledCache();
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
const syncSince = (env, key, token, area = BOOK) => report(env, area, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`);
const tokenOf = (text) => text.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
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
	await putCard(env, key, "other.vcf", vcard(["FN:Somebody Else", "EMAIL:other@example.test"], { uid: "other" }));
	await putCard(env, key, "me.vcf", vcard(["FN:Me Renamed", "EMAIL:u1@one.test", "EMAIL:Sales@one.test", "EMAIL:me2@example.test"], { uid: "me" }));
	assert.equal(sql.prepare("SELECT name FROM users WHERE id = 'u1'").get().name, "User One", "the account keeps its name");
	assert.equal(sql.prepare("SELECT count(*) AS n FROM mailboxes WHERE display_name IS NOT NULL").get().n, 0);
	assert.deepEqual([contact(sql, "u1@one.test").display_name, contact(sql, "u1@one.test").dav_card_id], ["User One", null], "the owner's address is not renamed or linked");
	assert.equal(contact(sql, "sales@one.test"), undefined, "an alias is not made a contact by the mirror");
	assert.deepEqual([contact(sql, "me2@example.test").display_name, contact(sql, "me2@example.test").dav_card_id], ["Me Renamed", card(sql, "me.vcf").id]);
});

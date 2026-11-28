import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-import-chunk-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		contacts: join(root, "src/lib/contacts/service.ts"),
		service: join(root, "src/lib/import/service.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "postal-mime"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { upsertContactsFromAddresses } = await load("contacts");
const { importMessagesToMailbox } = await load("service");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Math.floor(Date.now() / 1000);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'me@example.org', 'Me', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.org', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'me', ?)").run(now);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("", { status: 404 });
	t.after(() => { globalThis.fetch = originalFetch; });
	return database;
}

const lastSeen = (database, email) => database.db.prepare("SELECT last_seen_at AS t FROM contacts WHERE email = ?").get(email)?.t;

test("a new contact gets the supplied seenAt", async (t) => {
	const database = await fixture(t);
	await upsertContactsFromAddresses({ DB: database }, "u1", ["Pal <pal@x.test>"], "inbound", { seenAt: new Map([["pal@x.test", new Date("2020-05-01T00:00:00Z")]]), lookupAvatar: false });
	assert.equal(lastSeen(database, "pal@x.test"), sec("2020-05-01T00:00:00Z"));
});

test("an existing contact keeps a later lastSeenAt and moves forward to a later one", async (t) => {
	const database = await fixture(t);
	const insert = database.db.prepare("INSERT INTO contacts (id, user_id, email, source, last_seen_at, created_at) VALUES (?, 'u1', ?, 'inbound', ?, 1)");
	insert.run("c1", "late@x.test", sec("2023-01-01T00:00:00Z"));
	insert.run("c2", "early@x.test", sec("2019-01-01T00:00:00Z"));
	const when = new Date("2020-05-01T00:00:00Z");
	await upsertContactsFromAddresses({ DB: database }, "u1", ["late@x.test", "early@x.test"], "inbound", { seenAt: new Map([["late@x.test", when], ["early@x.test", when]]), lookupAvatar: false });
	assert.equal(lastSeen(database, "late@x.test"), sec("2023-01-01T00:00:00Z"));
	assert.equal(lastSeen(database, "early@x.test"), sec("2020-05-01T00:00:00Z"));
});

test("without options lastSeenAt is now, and lookupAvatar false never calls fetch", async (t) => {
	const database = await fixture(t);
	let calls = 0;
	globalThis.fetch = async () => { calls += 1; return new Response("", { status: 404 }); };
	await upsertContactsFromAddresses({ DB: database }, "u1", ["a@x.test"], "inbound", { lookupAvatar: false });
	assert.ok(Math.abs(lastSeen(database, "a@x.test") - Math.floor(Date.now() / 1000)) < 60);
	assert.equal(calls, 0);
});

// A header block over 64 KiB is rejected before parsing.
const tooBig = () => new TextEncoder().encode(`X-Big: ${"a".repeat(70_000)}`).buffer;

const rawMessage = (id, from, date) => new TextEncoder().encode([
	`From: ${from}`, "To: Me <me@example.org>", "Subject: s", `Message-ID: <${id}@x.test>`, `Date: ${date}`, "", "Hello",
].join("\r\n")).buffer;

function recordingDb(database, sql) {
	return new Proxy(database, {
		get(target, property) {
			if (property !== "prepare") return Reflect.get(target, property);
			return (statement) => { sql.push(statement); return target.prepare(statement); };
		},
	});
}

test("a chunk looks up Message-IDs once, writes contacts in a few statements and records message dates", async (t) => {
	const database = await fixture(t);
	database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, provider_message_id, created_at) VALUES ('old', 'u1', 'mb1', 'inbound', 'd@x.test', 'me@example.org', 's', 'b', 'inbox', '<m10@x.test>', 1)").run();
	const sql = [];
	const env = { DB: recordingDb(database, sql), BUCKET: { put: async () => undefined, delete: async () => undefined } };
	const items = [
		["m1", "A <a@x.test>", "Fri, 1 Jan 2021 10:00:00 +0000"],
		["m2", "A <a@x.test>", "Mon, 1 Mar 2021 10:00:00 +0000"],
		["m3", "A <a@x.test>", "Tue, 2 Feb 2021 10:00:00 +0000"],
		["m4", "B <b@x.test>", "Fri, 1 Jan 2021 10:00:00 +0000"],
		["m5", "B <b@x.test>", "Sat, 2 Jan 2021 10:00:00 +0000"],
		["m6", "C <c@x.test>", "Fri, 1 Jan 2021 10:00:00 +0000"],
		["m7", "D <d@x.test>", "Fri, 1 Jan 2021 10:00:00 +0000"],
		["m8", "D <d@x.test>", "Wed, 3 Feb 2021 10:00:00 +0000"],
		["m1", "A <a@x.test>", "Fri, 1 Jan 2021 10:00:00 +0000"],
		["m10", "D <d@x.test>", "Fri, 1 Jan 2021 10:00:00 +0000"],
	].map(([id, from, date], index) => ({ filename: `${index}.eml`, raw: rawMessage(id, from, date) }));
	items.push({ filename: "broken.eml", raw: tooBig() });

	const result = await importMessagesToMailbox(env, { userId: "u1", mailboxId: "mb1", destination: { type: "system", section: "inbox" }, messages: items });

	assert.equal(result.imported, 8);
	assert.equal(result.skipped, 3);
	assert.deepEqual(result.errors.map((error) => error.split(":")[0]), ["broken.eml"]);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM messages WHERE mailbox_id = 'mb1'").get().n, 9);
	assert.equal(sql.filter((statement) => /from "messages" where .*"provider_message_id"/i.test(statement)).length, 1);
	assert.ok(sql.filter((statement) => /"contacts"/i.test(statement)).length <= 8);
	assert.equal(lastSeen(database, "a@x.test"), sec("2021-03-01T10:00:00Z"));
	assert.equal(lastSeen(database, "d@x.test"), sec("2021-02-03T10:00:00Z"));
});

test("a parse failure is reported and the rest imports", async (t) => {
	const database = await fixture(t);
	const env = { DB: database, BUCKET: { put: async () => undefined, delete: async () => undefined } };
	const result = await importMessagesToMailbox(env, {
		userId: "u1", mailboxId: "mb1", destination: { type: "system", section: "inbox" },
		messages: [{ filename: "ok.eml", raw: rawMessage("ok", "A <a@x.test>", "Fri, 1 Jan 2021 10:00:00 +0000") }, { filename: "broken.eml", raw: tooBig() }],
	});
	assert.equal(result.imported, 1);
	assert.equal(result.skipped, 1);
	assert.match(result.errors[0], /^broken\.eml: /);
});

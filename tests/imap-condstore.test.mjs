import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ImapFlow } from "imapflow";
import { connectTlsClient } from "./helpers/imap-client.mjs";
import { makeHelpers, seedWorld } from "./helpers/imap-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-condstore-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { syncMailbox } from "./src/lib/imap/sync.ts";
			export { pruneImapExpunged, EXPUNGED_RETENTION_SECONDS } from "./src/lib/imap/expunge-prune.ts";
			export { FolderView } from "./src/lib/imap/view.ts";
			export { ImapServer } from "./server/imap/server.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { clearLoginAuditMemory } from "./src/lib/imap/auth.ts";
			export { openFileBucket } from "./server/runtime/file-bucket.ts";
			export { openRateLimiter } from "./server/runtime/misc.ts";
			export { parseModseq, subtractPresent, formatRanges, vanishedSince, changedSince, modseqsOf, maxModseqOf } from "./src/lib/imap/condstore.ts";
			export { processRequest } from "./src/lib/jmap/processor.ts";
			export { getDb } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-condstore-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { ImapServer, generateAppPassword, clearApiKeyVerificationCache, clearLoginAuditMemory, openFileBucket, openRateLimiter, SqliteDatabase, applyMigrations, syncMailbox, pruneImapExpunged, EXPUNGED_RETENTION_SECONDS, FolderView, parseModseq, subtractPresent, formatRanges, vanishedSince, changedSince, modseqsOf, maxModseqOf, processRequest, getDb } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sqlite = database.db;
	sqlite.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.test', 'x', 'U', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'me', 1);
	`);
	const env = { DB: database };
	let clock = 1000;
	let counter = 0;
	const add = (overrides = {}) => {
		const id = overrides.id ?? `g${++counter}`;
		const row = { user_id: "u1", mailbox_id: "m1", direction: "inbound", from_addr: "a@b.test", to_addr: "me@example.test", status: "received", subject: "s", text_body: "t", html_body: null, created_at: ++clock, ...overrides, id };
		const names = Object.keys(row);
		sqlite.prepare(`INSERT INTO messages (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
		return id;
	};
	const sync = () => syncMailbox(env, "m1");
	const expunged = (folder = "inbox") => sqlite.prepare("SELECT uid, modseq, created_at FROM imap_expunged WHERE mailbox_id = 'm1' AND folder_key = ? ORDER BY uid").all(folder);
	const floor = (folder = "inbox") => sqlite.prepare("SELECT expunged_floor FROM imap_folder_state WHERE id = ?").get(`m1:${folder}`).expunged_floor;
	/** Adds `count` messages, syncs, deletes them and syncs again: that many expunge rows. */
	const expungeSome = async (count, folder = "inbox", overrides = {}) => {
		const ids = Array.from({ length: count }, () => add(overrides));
		await sync();
		for (const id of ids) sqlite.prepare("DELETE FROM messages WHERE id = ?").run(id);
		await sync();
		return ids;
	};
	return { database, sqlite, env, add, sync, expunged, floor, expungeSome };
}

const NOW = new Date("2030-01-01T00:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const old = nowSeconds - EXPUNGED_RETENTION_SECONDS - 10;

test("prune deletes expunge rows older than 30 days, keeps newer ones and records the floor", async (t) => {
	const { sqlite, env, expungeSome, expunged, floor } = await fixture(t);
	await expungeSome(3);
	const rows = expunged();
	assert.equal(rows.length, 3);
	assert.equal(floor(), 0, "nothing pruned yet");
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid IN (1, 2)").run(old);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid = 3").run(nowSeconds - 60);
	const removed = await pruneImapExpunged(env, NOW);
	assert.equal(removed, 2);
	assert.deepEqual(expunged().map((row) => row.uid), [3]);
	assert.equal(floor(), Math.max(rows[0].modseq, rows[1].modseq), "the floor is the highest modseq that was dropped");
	assert.equal(await pruneImapExpunged(env, NOW), 0, "nothing left to do");
	assert.equal(floor(), Math.max(rows[0].modseq, rows[1].modseq), "and the floor stays");
});

test("a newer row with a lower modseq than a dropped one goes too, so the floor stays exact", async (t) => {
	const { sqlite, env, expungeSome, expunged, floor } = await fixture(t);
	await expungeSome(3);
	const rows = expunged();
	// Clocks can disagree between writers: the row with the highest modseq looks old, the others look new.
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid = 3").run(old);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid IN (1, 2)").run(nowSeconds);
	await pruneImapExpunged(env, NOW);
	assert.deepEqual(expunged(), [], "nothing at or below the floor is kept: a reader could not tell it was complete");
	assert.equal(floor(), rows[2].modseq);
});

test("pruning one folder leaves another folder's rows and floor alone, and rows without folder state go too", async (t) => {
	const { sqlite, env, expungeSome, expunged, floor } = await fixture(t);
	await expungeSome(1);
	await expungeSome(1, "archive", { status: "archived" });
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE folder_key = 'inbox'").run(old);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE folder_key = 'archive'").run(nowSeconds);
	sqlite.prepare("INSERT INTO imap_expunged (mailbox_id, folder_key, uid, modseq, created_at) VALUES ('gone', 'inbox', 4, 9, ?)").run(old);
	assert.equal(await pruneImapExpunged(env, NOW), 2);
	assert.equal(expunged().length, 0);
	assert.equal(expunged("archive").length, 1);
	assert.ok(floor() > 0);
	assert.equal(floor("archive"), 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_expunged WHERE mailbox_id = 'gone'").get().n, 0, "rows of a deleted mailbox are not kept forever");
});

test("a prune batch starts with the statement a sync starts with, so the two take the mailbox lock in the same order", async (t) => {
	const { sqlite, database, env, expungeSome } = await fixture(t);
	await expungeSome(1);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	const batches = [];
	const batch = database.batch.bind(database);
	database.batch = (statements) => {
		batches.push(statements.map((statement) => statement.sql));
		return batch(statements);
	};
	assert.equal(await pruneImapExpunged(env, NOW), 1);
	assert.equal(batches.length, 1);
	assert.equal(batches[0][0], "UPDATE imap_mailbox_state SET modseq = modseq WHERE mailbox_id = ?");
});

test("the prune finds the old rows through an index on their age", async (t) => {
	const { sqlite } = await fixture(t);
	const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT mailbox_id, folder_key, modseq FROM imap_expunged WHERE created_at < ? ORDER BY created_at LIMIT ?").all(1, 100).map((row) => row.detail).join("\n");
	assert.match(plan, /USING (COVERING )?INDEX imap_expunged_created_idx/);
});

test("the floor never goes down, and many folders are pruned in several rounds", async (t) => {
	const { sqlite, env, expungeSome, floor } = await fixture(t);
	await expungeSome(2);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	await pruneImapExpunged(env, NOW);
	const first = floor();
	sqlite.prepare("UPDATE imap_folder_state SET expunged_floor = ? WHERE id = 'm1:inbox'").run(first + 100);
	await expungeSome(1);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	await pruneImapExpunged(env, NOW);
	assert.equal(floor(), first + 100, "a higher floor is kept");
	for (let index = 0; index < 250; index += 1) sqlite.prepare("INSERT INTO imap_expunged (mailbox_id, folder_key, uid, modseq, created_at) VALUES (?, 'inbox', 1, 5, ?)").run(`orphan${index}`, old);
	assert.equal(await pruneImapExpunged(env, NOW), 250, "more groups than one round holds are all reached");
});

// ---- Mod-sequence helpers ----

test("parseModseq accepts 0 and digits, clamps what a number cannot hold, and refuses the rest", () => {
	assert.equal(parseModseq("0"), 0);
	assert.equal(parseModseq("123"), 123);
	assert.equal(parseModseq("9223372036854775807"), Number.MAX_SAFE_INTEGER, "beyond anything this server has handed out");
	for (const bad of ["", "-1", "1.5", "abc", "12a", "+5", "99999999999999999999", " 5"]) assert.equal(parseModseq(bad), null, JSON.stringify(bad));
});

test("subtractPresent removes the UIDs that exist from the ranges and keeps the rest as ranges", () => {
	assert.deepEqual(subtractPresent([[1, 10]], [2, 3, 7]), [[1, 1], [4, 6], [8, 10]]);
	assert.deepEqual(subtractPresent([[1, 5]], [1, 2, 3, 4, 5]), []);
	assert.deepEqual(subtractPresent([[3, 4], [8, 20]], [4, 10, 11]), [[3, 3], [8, 9], [12, 20]]);
	assert.deepEqual(subtractPresent([[5, 4]], []), [], "an empty range stays empty");
	assert.deepEqual(subtractPresent([[1, 4_000_000_000]], [5]), [[1, 4], [6, 4_000_000_000]], "the size of a range costs nothing");
	assert.equal(formatRanges([[1, 1], [4, 6], [8, 10]]), "1,4:6,8:10");
});

async function openView(env) {
	return FolderView.open(env, "m1", "inbox");
}

test("vanishedSince lists the UIDs expunged after a mod-sequence, from the rows that are kept", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = [add(), add(), add(), add(), add()];
	await sync();
	const before = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[1]);
	await sync();
	const middle = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[3]);
	await sync();
	const view = await openView(env);
	assert.deepEqual(await vanishedSince(env, view, before, null), [[2, 2], [4, 4]]);
	assert.deepEqual(await vanishedSince(env, view, middle, null), [[4, 4]], "only what vanished after that point");
	assert.deepEqual(await vanishedSince(env, view, view.highest, null), []);
	assert.deepEqual(await vanishedSince(env, view, before, [[3, 100]]), [[4, 4]], "limited to the UIDs the client asked about");
});

test("below the floor the answer is computed from the UIDs that exist, and stays exact", async (t) => {
	const { sqlite, env, add, sync, floor } = await fixture(t);
	const ids = [add(), add(), add(), add(), add()];
	await sync();
	const start = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("DELETE FROM messages WHERE id IN (?, ?)").run(ids[1], ids[3]);
	await sync();
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	await pruneImapExpunged(env, NOW);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_expunged").get().n, 0, "the rows are gone");
	assert.ok(floor() > start);
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[4]);
	await sync();
	const view = await openView(env);
	assert.deepEqual(await vanishedSince(env, view, start, [[1, 5]]), [[2, 2], [4, 5]], "what was pruned and what was not");
	assert.deepEqual(await vanishedSince(env, view, start, null), [[2, 2], [4, 5]], "no list of known UIDs: every UID ever assigned that is gone");
	assert.deepEqual(await vanishedSince(env, view, start, [[3, 4]]), [[4, 4]]);
	assert.deepEqual(await vanishedSince(env, view, start, [[1, 100]]), [[2, 2], [4, 5]], "UIDs never assigned are not reported");
	// At or above the floor the kept rows are complete.
	assert.deepEqual(await vanishedSince(env, view, floor(), null), [[5, 5]]);
});

test("a log larger than one command may read is answered from the UIDs that exist, with the same result", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = Array.from({ length: 12 }, () => add());
	await sync();
	const start = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	for (const id of ids.filter((_, index) => index % 2 === 0)) sqlite.prepare("DELETE FROM messages WHERE id = ?").run(id);
	await sync();
	const view = await openView(env);
	const expected = [[1, 1], [3, 3], [5, 5], [7, 7], [9, 9], [11, 11]];
	assert.deepEqual(await vanishedSince(env, view, start, null), expected);
	assert.deepEqual(await vanishedSince(env, view, start, null, 3), expected, "a cap of 3 rows over a log of 6 forces the other path");
});

test("changedSince and modseqsOf read the mod-sequences of the folder", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = [add(), add(), add()];
	await sync();
	const since = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("UPDATE messages SET starred = ? WHERE id = ?").run(1, ids[1]);
	await sync();
	assert.deepEqual([...(await changedSince(env, "m1", "inbox", since))], [2]);
	assert.deepEqual([...(await changedSince(env, "m1", "inbox", 0))].sort(), [1, 2, 3]);
	const found = await modseqsOf(env, "m1", "inbox", [1, 2, 3]);
	assert.ok(found.get(2) > since && found.get(1) <= since);
	assert.equal(await maxModseqOf(env, "m1", "inbox", [1, 3]), Math.max(found.get(1), found.get(3)));
	assert.equal(await maxModseqOf(env, "m1", "inbox", [1, 2, 3, 99]), found.get(2));
	assert.equal(await maxModseqOf(env, "m1", "inbox", []), 0);
	assert.deepEqual([...(await modseqsOf(env, "m1", "inbox", [2, 3, 99])).keys()].sort(), [2, 3]);
	const many = await modseqsOf(env, "m1", "inbox", Array.from({ length: 250 }, (_, index) => index + 1));
	assert.equal(many.size, 3, "chunked lookups give the same answer");
});

// ---- Protocol ----

const keyPath = join(directory, "key.pem");
const certPath = join(directory, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
const certificate = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
const ca = certificate.cert;

async function world(t, options = {}) {
	clearApiKeyVerificationCache();
	clearLoginAuditMemory();
	const database = new SqliteDatabase(":memory:");
	const bucket = openFileBucket(mkdtempSync(join(directory, "blobs-")));
	await applyMigrations(database, join(root, "drizzle/migrations"));
	seedWorld(database.db);
	const helpers = makeHelpers(database.db, generateAppPassword);
	const env = { DB: database, BUCKET: bucket, MAILFLARE_RUNTIME: "node", DEVICE_LOGIN_RATE_LIMIT: openRateLimiter(10, 60) };
	const server = new ImapServer({ env, hostname: "mail.example.test", tlsPort: 0, starttlsPort: null, host: "127.0.0.1", certificate, failureDelayMs: 0, pollMs: 100, ...options });
	const ports = await server.start();
	t.after(async () => {
		await server.stop();
		database.db.close();
		clearApiKeyVerificationCache();
	});
	const sqlite = database.db;
	const uidRows = (folder = "inbox") => sqlite.prepare("SELECT uid, message_id, modseq FROM imap_uids WHERE mailbox_id = 'm1' AND folder_key = ? ORDER BY uid").all(folder);
	const folder = (key = "inbox") => sqlite.prepare("SELECT * FROM imap_folder_state WHERE id = ?").get(`m1:${key}`);
	return { ...helpers, sqlite, env, server, ports, uidRows, folder, open: () => connectTlsClient(ports.tlsPort, ca) };
}

async function loggedIn(w, key, t, user = "me@example.test") {
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	const result = await client.login(user, key.fullKey);
	assert.equal(result.status, "OK", result.text);
	return client;
}

const modseqOf = (text, uid) => Number(new RegExp(`UID ${uid}[^\\r]*?MODSEQ \\((\\d+)\\)`).exec(text)?.[1]);

test("CAPABILITY offers CONDSTORE and QRESYNC after login, not before", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	assert.doesNotMatch((await client.cmd("CAPABILITY")).text, /CONDSTORE|QRESYNC/);
	await client.login("me@example.test", key.fullKey);
	assert.match((await client.cmd("CAPABILITY")).text, /\* CAPABILITY .*\bCONDSTORE\b.*\bQRESYNC\b/);
});

test("ENABLE CONDSTORE and QRESYNC report what they turned on; QRESYNC may not be turned on with a folder selected", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key, t);
	assert.equal((await client.cmd("ENABLE CONDSTORE")).text.split("\r\n")[0], "* ENABLED CONDSTORE");
	assert.equal((await client.cmd("ENABLE CONDSTORE")).text.split("\r\n")[0], "* ENABLED", "already on");
	assert.equal((await client.cmd("ENABLE QRESYNC")).text.split("\r\n")[0], "* ENABLED QRESYNC", "CONDSTORE was on already");
	assert.equal((await client.cmd("ENABLE FUTURE-THING")).text.split("\r\n")[0], "* ENABLED", "unknown names are ignored");
	const second = await loggedIn(w, key, t);
	assert.equal((await second.cmd("ENABLE QRESYNC")).text.split("\r\n")[0], "* ENABLED CONDSTORE QRESYNC", "QRESYNC brings CONDSTORE");
	const third = await loggedIn(w, key, t);
	await third.cmd("SELECT INBOX");
	const refused = await third.cmd("ENABLE QRESYNC");
	assert.equal(refused.status, "BAD");
	assert.equal((await third.cmd("ENABLE CONDSTORE")).status, "OK");
});

test("SELECT announces HIGHESTMODSEQ; the CONDSTORE parameter turns MODSEQ on in flag updates", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const a = w.addMessage();
	w.addMessage();
	const client = await loggedIn(w, key, t);
	const select = await client.cmd("SELECT INBOX");
	assert.match(select.text, new RegExp(`\\* OK \\[HIGHESTMODSEQ ${w.folder().highest_modseq}\\]`));
	w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(a);
	assert.match((await client.cmd("NOOP")).text, /\* 1 FETCH \(FLAGS \(\\Flagged\) UID 1\)\r\n/, "no MODSEQ before CONDSTORE is on");
	assert.equal((await client.cmd("SELECT INBOX (CONDSTORE)")).status, "OK");
	w.sqlite.prepare("UPDATE messages SET starred = 0 WHERE id = ?").run(a);
	const update = await client.cmd("NOOP");
	const rows = w.uidRows();
	assert.match(update.text, new RegExp(`\\* 1 FETCH \\(FLAGS \\(\\) UID 1 MODSEQ \\(${rows[0].modseq}\\)\\)\r\n`));
	assert.match(update.text, new RegExp(`\\* OK \\[HIGHESTMODSEQ ${w.folder().highest_modseq}\\]`), "the new highest value is announced with the update");
	assert.equal((await client.cmd("SELECT INBOX (FOO)")).status, "BAD");
	assert.equal((await client.cmd("SELECT INBOX (QRESYNC (1 1))")).status, "BAD", "QRESYNC was not enabled");
});

test("FETCH MODSEQ, and CHANGEDSINCE with its implicit MODSEQ", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const [a, b, c] = [w.addMessage(), w.addMessage(), w.addMessage()];
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const before = w.uidRows();
	w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id IN (?, ?)").run(b, c);
	await client.cmd("NOOP");
	const rows = w.uidRows();
	assert.ok(rows[1].modseq > before[1].modseq && rows[0].modseq === before[0].modseq);
	const plain = await client.cmd("UID FETCH 1:3 (FLAGS MODSEQ)");
	for (const row of rows) assert.equal(modseqOf(plain.text, row.uid), row.modseq);
	const changed = await client.cmd(`UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${rows[0].modseq})`);
	assert.doesNotMatch(changed.text, /UID 1 /);
	assert.equal(modseqOf(changed.text, 2), rows[1].modseq, "MODSEQ is added without being asked for");
	assert.equal(modseqOf(changed.text, 3), rows[2].modseq);
	const bySeq = await client.cmd(`FETCH 1:3 (UID) (CHANGEDSINCE ${rows[2].modseq})`);
	assert.doesNotMatch(bySeq.text, /\* \d+ FETCH/, "nothing is newer than the newest");
	assert.equal((await client.cmd("FETCH 1 (FLAGS) (CHANGEDSINCE abc)")).status, "BAD");
	assert.equal((await client.cmd("FETCH 1 (FLAGS) (FOO 1)")).status, "BAD");
	void a;
});

test("UID FETCH CHANGEDSINCE with VANISHED lists what vanished in the set, and needs QRESYNC", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const ids = [w.addMessage(), w.addMessage(), w.addMessage(), w.addMessage()];
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const start = w.folder().highest_modseq;
	assert.equal((await client.cmd(`UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${start} VANISHED)`)).status, "BAD", "QRESYNC is not enabled");
	const qres = await loggedIn(w, key, t);
	await qres.cmd("ENABLE QRESYNC");
	await qres.cmd("SELECT INBOX");
	w.sqlite.prepare("DELETE FROM messages WHERE id IN (?, ?)").run(ids[1], ids[3]);
	await qres.cmd("NOOP");
	const answer = await qres.cmd(`UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${start} VANISHED)`);
	assert.match(answer.text, /^\* VANISHED \(EARLIER\) 2,4\r\n/, "before the FETCH responses; the set is 1:* but * does not hide UID 4");
	assert.equal((await qres.cmd(`UID FETCH 3:4 (FLAGS) (CHANGEDSINCE ${start} VANISHED)`)).text.split("\r\n")[0], "* VANISHED (EARLIER) 4");
	assert.equal((await qres.cmd(`FETCH 1:2 (FLAGS) (CHANGEDSINCE ${start} VANISHED)`)).status, "BAD", "VANISHED is for UID FETCH");
});

test("STORE with UNCHANGEDSINCE stores what is unchanged, answers MODSEQ, and lists the rest as MODIFIED", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const [a, b, c] = [w.addMessage(), w.addMessage(), w.addMessage()];
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const since = w.folder().highest_modseq;
	w.sqlite.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(b);
	const result = await client.cmd(`STORE 1:3 (UNCHANGEDSINCE ${since}) +FLAGS (\\Flagged)`);
	assert.match(result.detail, /^\[MODIFIED 2\]/, "the message another writer changed meanwhile is not stored");
	const starred = w.sqlite.prepare("SELECT id, starred FROM messages ORDER BY created_at").all().map((row) => [row.id, row.starred]);
	assert.deepEqual(starred, [[a, 1], [b, 0], [c, 1]]);
	const rows = w.uidRows();
	assert.equal(modseqOf(result.text, 1), rows[0].modseq);
	assert.equal(modseqOf(result.text, 3), rows[2].modseq);
	assert.match(result.text, /\* 1 FETCH \(FLAGS \(\\Flagged\) UID 1 MODSEQ/);
	assert.doesNotMatch(result.text, /\* 2 FETCH \(FLAGS \(\\Flagged\)/);
	// UID STORE reports UIDs; a silent STORE still reports the new MODSEQ (and no flags).
	const silent = await client.cmd(`UID STORE 1 (UNCHANGEDSINCE 0) -FLAGS.SILENT (\\Flagged)`);
	assert.match(silent.detail, /^\[MODIFIED 1\]/, "UNCHANGEDSINCE 0 stores nothing");
	const quiet = await client.cmd(`UID STORE 3 (UNCHANGEDSINCE ${w.folder().highest_modseq}) -FLAGS.SILENT (\\Flagged)`);
	assert.equal(quiet.status, "OK");
	assert.doesNotMatch(quiet.detail, /MODIFIED/);
	assert.match(quiet.text, /^\* 3 FETCH \(UID 3 MODSEQ \(\d+\)\)\r\n/);
	assert.equal(w.sqlite.prepare("SELECT starred FROM messages WHERE id = ?").get(c).starred, 0);
	assert.equal((await client.cmd("STORE 1 (UNCHANGEDSINCE) +FLAGS (\\Seen)")).status, "BAD");
	assert.equal((await client.cmd("STORE 1 (FOO 1) +FLAGS (\\Seen)")).status, "BAD");
});

test("SEARCH MODSEQ finds messages at or above a mod-sequence and reports the highest one found", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const [, b, c] = [w.addMessage(), w.addMessage(), w.addMessage()];
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const since = w.folder().highest_modseq;
	w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id IN (?, ?)").run(b, c);
	await client.cmd("NOOP");
	const rows = w.uidRows();
	const searchLine = (text) => text.split("\r\n").find((line) => line.startsWith("* SEARCH"));
	assert.equal(searchLine((await client.cmd(`SEARCH MODSEQ ${since + 1}`)).text), `* SEARCH 2 3 (MODSEQ ${rows[2].modseq})`);
	assert.equal(searchLine((await client.cmd(`SEARCH MODSEQ "/flags/\\\\Flagged" all ${rows[2].modseq}`)).text), `* SEARCH 3 (MODSEQ ${rows[2].modseq})`);
	assert.match((await client.cmd(`UID SEARCH RETURN (ALL) MODSEQ ${since + 1}`)).text, new RegExp(`^\\* ESEARCH \\(TAG "a\\d+"\\) UID ALL 2:3 MODSEQ ${rows[2].modseq}\r\n`));
	assert.equal(searchLine((await client.cmd("SEARCH MODSEQ 99999")).text), "* SEARCH", "no match, no MODSEQ data");
	assert.equal((await client.cmd("SEARCH MODSEQ abc")).status, "BAD");
	// Using MODSEQ turned CONDSTORE on.
	w.sqlite.prepare("UPDATE messages SET starred = 0 WHERE id = ?").run(b);
	assert.match((await client.cmd("NOOP")).text, /\* 2 FETCH \(FLAGS \(\) UID 2 MODSEQ \(\d+\)\)/);
});

test("STATUS and LIST-STATUS answer HIGHESTMODSEQ", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage();
	w.addMessage();
	const client = await loggedIn(w, key, t);
	const status = await client.cmd("STATUS INBOX (HIGHESTMODSEQ MESSAGES)");
	await client.cmd("SELECT INBOX");
	assert.equal(status.text.split("\r\n")[0], `* STATUS "INBOX" (HIGHESTMODSEQ ${w.folder().highest_modseq} MESSAGES 2)`);
	const list = await client.cmd('LIST "" "INBOX" RETURN (STATUS (HIGHESTMODSEQ))');
	assert.match(list.text, new RegExp(`\\* STATUS "INBOX" \\(HIGHESTMODSEQ ${w.folder().highest_modseq}\\)`));
	const idle = await loggedIn(w, key, t);
	await idle.cmd("STATUS INBOX (HIGHESTMODSEQ)");
	await idle.cmd("SELECT INBOX");
	w.sqlite.prepare("UPDATE messages SET starred = 1").run();
	assert.match((await idle.cmd("NOOP")).text, /MODSEQ \(\d+\)/, "asking for HIGHESTMODSEQ turned CONDSTORE on");
});

test("HIGHESTMODSEQ never goes down, also after expunges and folder moves", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const ids = [w.addMessage(), w.addMessage(), w.addMessage()];
	const client = await loggedIn(w, key, t);
	let last = 0;
	for (const step of [() => {}, () => w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(ids[0]), () => w.sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[1]), () => w.sqlite.prepare("UPDATE messages SET status = 'archived' WHERE id = ?").run(ids[2])]) {
		step();
		const text = (await client.cmd("STATUS INBOX (HIGHESTMODSEQ)")).text;
		const value = Number(/HIGHESTMODSEQ (\d+)/.exec(text)?.[1]);
		assert.ok(value >= last, `${value} >= ${last}`);
		last = value;
	}
	assert.ok(last > 0);
});

// ---- QRESYNC ----

/** Five messages (UIDs 1..5), a client that saw them all, then: UIDs 2 and 4 deleted, UID 5 starred, UID 6 arrives. */
async function resyncWorld(t) {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const ids = [w.addMessage(), w.addMessage(), w.addMessage(), w.addMessage(), w.addMessage()];
	const first = await loggedIn(w, key, t);
	await first.cmd("ENABLE QRESYNC");
	const select = await first.cmd("SELECT INBOX");
	const validity = Number(/UIDVALIDITY (\d+)/.exec(select.text)[1]);
	const highest = Number(/HIGHESTMODSEQ (\d+)/.exec(select.text)[1]);
	first.end();
	w.sqlite.prepare("DELETE FROM messages WHERE id IN (?, ?)").run(ids[1], ids[3]);
	w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(ids[4]);
	w.addMessage();
	const second = await loggedIn(w, key, t);
	await second.cmd("ENABLE QRESYNC");
	return { w, key, ids, validity, highest, second };
}

test("SELECT with QRESYNC answers what vanished and what changed since the client's mod-sequence", async (t) => {
	const { w, validity, highest, second } = await resyncWorld(t);
	const select = await second.cmd(`SELECT INBOX (QRESYNC (${validity} ${highest}))`);
	assert.equal(select.status, "OK", select.detail);
	assert.match(select.text, /\* 4 EXISTS\r\n/);
	assert.match(select.text, new RegExp(`\\* OK \\[HIGHESTMODSEQ ${w.folder().highest_modseq}\\]`));
	assert.match(select.text, /\* VANISHED \(EARLIER\) 2,4\r\n/);
	const rows = w.uidRows();
	assert.match(select.text, new RegExp(`\\* 3 FETCH \\(FLAGS \\(\\\\Flagged\\) UID 5 MODSEQ \\(${rows.find((row) => row.uid === 5).modseq}\\)\\)\\r\\n`), "a flag change");
	assert.match(select.text, new RegExp(`\\* 4 FETCH \\(FLAGS \\(\\) UID 6 MODSEQ \\(${rows.find((row) => row.uid === 6).modseq}\\)\\)\\r\\n`), "a new message shows as changed");
	assert.doesNotMatch(select.text, /UID 1 |UID 3 /, "unchanged messages are not repeated");
	assert.ok(select.text.indexOf("VANISHED") < select.text.indexOf("FETCH"), "VANISHED comes first");
	// The known UIDs only narrow the answer; and the same select again, with the folder up to date, is empty.
	const known = await second.cmd(`SELECT INBOX (QRESYNC (${validity} ${highest} 1:3))`);
	assert.match(known.text, /\* VANISHED \(EARLIER\) 2\r\n/);
	assert.doesNotMatch(known.text, /VANISHED \(EARLIER\) [^\r]*4/);
	const matched = await second.cmd(`SELECT INBOX (QRESYNC (${validity} ${highest} 1:5 (1,3,5 1,3,5)))`);
	assert.match(matched.text, /\* VANISHED \(EARLIER\) 2,4\r\n/, "message number matching data is accepted");
	const current = await second.cmd(`SELECT INBOX (QRESYNC (${validity} ${w.folder().highest_modseq}))`);
	assert.doesNotMatch(current.text, /VANISHED|FETCH/);
	assert.match(current.text, /^\* OK \[CLOSED\]/, "the folder that was open is announced as closed");
});

test("a QRESYNC select with another UIDVALIDITY is an ordinary select; bad parameters are refused", async (t) => {
	const { w, validity, highest, second } = await resyncWorld(t);
	const other = await second.cmd(`SELECT INBOX (QRESYNC (${validity + 1} ${highest}))`);
	assert.equal(other.status, "OK");
	assert.doesNotMatch(other.text, /VANISHED|FETCH/, "the client sees the folder's own UIDVALIDITY and starts over");
	assert.match(other.text, new RegExp(`UIDVALIDITY ${w.folder().uidvalidity}`));
	for (const bad of ["(QRESYNC)", "(QRESYNC (1))", "(QRESYNC (abc 5))", "(QRESYNC (1 abc))", "(QRESYNC (1 5 xyz))", "(QRESYNC (1 5 1:3 (1)))", "(QRESYNC (1 5 1:3 (1 2) 9))", "(QRESYNC 5)", "(QRESYNC (1 99999999999999999999))".replace("99999999999999999999", "-1")]) {
		assert.equal((await second.cmd(`SELECT INBOX ${bad}`)).status, "BAD", bad);
	}
	const plain = await loggedIn(w, await w.addKey({ id: "k2" }), t);
	assert.equal((await plain.cmd(`SELECT INBOX (QRESYNC (${validity} ${highest}))`)).detail, "QRESYNC is not enabled");
});

test("a QRESYNC select from below the floor still lists what vanished, also what was pruned", async (t) => {
	const { w, validity, highest, second } = await resyncWorld(t);
	await second.cmd("SELECT INBOX");
	w.sqlite.prepare("UPDATE imap_expunged SET created_at = 1").run();
	const { pruneImapExpunged: prune } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
	assert.equal(await prune(w.env, new Date()), 2);
	assert.equal(w.sqlite.prepare("SELECT COUNT(*) AS n FROM imap_expunged").get().n, 0);
	for (const params of [`${validity} ${highest}`, `${validity} ${highest} 1:6`, `${validity} 0`]) {
		const select = await second.cmd(`SELECT INBOX (QRESYNC (${params}))`);
		assert.match(select.text, /\* VANISHED \(EARLIER\) 2,4\r\n/, params);
	}
	assert.match((await second.cmd(`UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${highest} VANISHED)`)).text, /^\* VANISHED \(EARLIER\) 2,4\r\n/);
});

test("with QRESYNC on, removals are announced as VANISHED, never EXPUNGE", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const ids = [w.addMessage(), w.addMessage(), w.addMessage(), w.addMessage()];
	const qres = await loggedIn(w, key, t);
	await qres.cmd("ENABLE QRESYNC");
	await qres.cmd("SELECT INBOX");
	const plain = await loggedIn(w, key, t);
	await plain.cmd("SELECT INBOX");
	w.sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[1]);
	const pushed = await qres.cmd("NOOP");
	assert.match(pushed.text, /\* VANISHED 2\r\n/);
	assert.doesNotMatch(pushed.text, /EXPUNGE/);
	assert.match((await plain.cmd("NOOP")).text, /\* 2 EXPUNGE\r\n/, "a client without QRESYNC still gets EXPUNGE");
	// The client's own EXPUNGE: the response is VANISHED too.
	await qres.cmd("UID STORE 3 +FLAGS (\\Deleted)");
	const own = await qres.cmd("EXPUNGE");
	assert.match(own.text, /\* VANISHED 3\r\n/);
	assert.doesNotMatch(own.text, /EXPUNGE\r\n\* /);
	assert.equal(w.uidRows().map((row) => row.uid).join(), "1,4");
	// Several UIDs come as ranges.
	w.sqlite.prepare("DELETE FROM messages").run();
	assert.match((await qres.cmd("NOOP")).text, /\* VANISHED 1,4\r\n/);
	w.addMessage();
	w.addMessage();
	await qres.cmd("NOOP");
	w.sqlite.prepare("DELETE FROM messages").run();
	assert.match((await qres.cmd("NOOP")).text, /\* VANISHED 5:6\r\n/);
});

test("a long VANISHED answer is split over lines of bounded size", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	// 2500 messages, every other one removed: 1250 separate ranges.
	for (let index = 0; index < 2500; index += 1) w.sqlite.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, subject, created_at) VALUES (?, 'u1', 'm1', 'inbound', 'a@b.test', 'me@example.test', 'received', 's', ?)").run(`bulk${index}`, 1000 + index);
	const first = await loggedIn(w, key, t);
	await first.cmd("ENABLE QRESYNC");
	const select = await first.cmd("SELECT INBOX");
	const validity = /UIDVALIDITY (\d+)/.exec(select.text)[1];
	w.sqlite.prepare("DELETE FROM messages WHERE CAST(substr(id, 5) AS INTEGER) % 2 = 1").run();
	const resumed = await loggedIn(w, key, t);
	await resumed.cmd("ENABLE QRESYNC");
	const answer = await resumed.cmd(`SELECT INBOX (QRESYNC (${validity} 1))`);
	const lines = answer.lines.filter((line) => line.startsWith("* VANISHED (EARLIER)"));
	assert.equal(lines.length, 2, "1250 ranges at 1000 per line");
	assert.ok(lines.every((line) => line.split(",").length <= 1000));
	assert.equal(lines.join(",").split(",").length, 1250);
});

test("imapflow resyncs a folder with QRESYNC: it hears what vanished and what changed", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const ids = [w.addMessage(), w.addMessage(), w.addMessage()];
	const client = new ImapFlow({ host: "127.0.0.1", port: w.ports.tlsPort, secure: true, auth: { user: "me@example.test", pass: key.fullKey }, tls: { ca, servername: "localhost" }, qresync: true, logger: false });
	await client.connect();
	t.after(() => client.logout().catch(() => {}));
	assert.equal(client.enabled.has("QRESYNC"), true, "the client enabled it");
	const events = [];
	client.on("expunge", (event) => events.push(["expunge", event.uid ?? event.seq, event.vanished === true]));
	client.on("flags", (event) => events.push(["flags", event.uid, event.modseq !== undefined]));
	const lock = await client.getMailboxLock("INBOX");
	try {
		assert.ok(client.mailbox.highestModseq > 0n, "HIGHESTMODSEQ arrived");
		w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(ids[0]);
		w.sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[1]);
		await client.noop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(events.find((event) => event[0] === "expunge")?.slice(1), [2, true], "removal arrives as VANISHED");
		assert.deepEqual(events.find((event) => event[0] === "flags")?.slice(1), [1, true], "flag update with a mod-sequence");
		const changed = [];
		for await (const message of client.fetch("1:*", { uid: true, flags: true }, { uid: true, changedSince: 0n })) changed.push(message.uid);
		assert.deepEqual(changed, [1, 3]);
	} finally {
		lock.release();
	}
});

test("with QRESYNC on, a MOVE out of the folder is answered with VANISHED for the source", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage();
	w.addMessage();
	const client = await loggedIn(w, key, t);
	await client.cmd("ENABLE QRESYNC");
	await client.cmd("SELECT INBOX");
	const moved = await client.cmd("UID MOVE 2 Archive");
	assert.equal(moved.status, "OK", moved.detail);
	assert.match(moved.text, /\* VANISHED 2\r\n/);
	assert.doesNotMatch(moved.text, /EXPUNGE/);
});

// ---- Review fixes ----

/** Runs `action` once, just before or just after the first read whose statement matches `pattern`. */
function atStatement(w, pattern, action, when = "before") {
	const database = w.env.DB;
	const prepare = database.prepare.bind(database);
	let fired = false;
	database.prepare = (sql) => {
		const statement = prepare(sql);
		if (fired || !pattern.test(sql)) return statement;
		return {
			bind: (...values) => {
				const bound = statement.bind(...values);
				const around = (method) => async () => {
					if (fired) return bound[method]();
					fired = true;
					if (when === "before") await action();
					const result = await bound[method]();
					if (when === "after") await action();
					return result;
				};
				return { all: around("all"), run: around("run"), raw: around("raw"), first: around("first") };
			},
		};
	};
}

/** Every statement the database is asked to prepare from now on. */
function recordStatements(w) {
	const database = w.env.DB;
	const prepare = database.prepare.bind(database);
	const seen = [];
	database.prepare = (sql) => {
		seen.push(sql);
		return prepare(sql);
	};
	return seen;
}

const MODSEQ_READ = /^SELECT uid, modseq FROM imap_uids/;
const webStars = (w, id = "g1") => async () => {
	w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(id);
	await syncMailbox(w.env, "m1");
};

test("a FETCH that marks a message read reports the flags and mod-sequence the message has after the write", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX (CONDSTORE)");
	// The web stars the message after the response was written and before the version is read.
	atStatement(w, MODSEQ_READ, webStars(w), "before");
	const fetch = await client.cmd("FETCH 1 (BODY[TEXT])");
	assert.equal(fetch.status, "OK");
	const current = w.uidRows()[0].modseq;
	assert.match(fetch.text, new RegExp(`\\* 1 FETCH \\(FLAGS \\(\\\\Seen \\\\Flagged\\) UID 1 MODSEQ \\(${current}\\)\\)\r\n`));
	assert.doesNotMatch((await client.cmd("NOOP")).text, /FETCH/, "what the client was told is not announced again");
});

test("a change that lands while a FETCH marks a message read is announced afterwards, not hidden", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX (CONDSTORE)");
	// The star arrives after the version the client is given was read.
	atStatement(w, MODSEQ_READ, webStars(w), "after");
	const fetch = await client.cmd("FETCH 1 (BODY[TEXT])");
	const told = Number(/UID 1 MODSEQ \((\d+)\)/.exec(fetch.text)?.[1]);
	const current = w.uidRows()[0].modseq;
	assert.ok(told < current, `the client holds ${told}, the message is at ${current}`);
	const noop = await client.cmd("NOOP");
	assert.match(noop.text, new RegExp(`\\* 1 FETCH \\(FLAGS \\(\\\\Seen \\\\Flagged\\) UID 1 MODSEQ \\(${current}\\)\\)`));
});

test("a FETCH without CONDSTORE tells the client the flags after the write too", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	atStatement(w, MODSEQ_READ, webStars(w), "after");
	const fetch = await client.cmd("FETCH 1 (BODY[TEXT])");
	assert.match(fetch.text, /\* 1 FETCH \(FLAGS \(\\Seen \\Flagged\) UID 1\)\r\n/);
	assert.doesNotMatch(fetch.text, /MODSEQ/);
});

test("FETCH reads the mod-sequence before the flags, so the flags are never older than the number", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	atStatement(w, MODSEQ_READ, webStars(w), "before");
	const answer = await client.cmd("UID FETCH 1 (FLAGS MODSEQ BODY.PEEK[TEXT])");
	const current = w.uidRows()[0].modseq;
	assert.equal(modseqOf(answer.text, 1), current, "the version is the current one");
	assert.match(answer.text, /FLAGS \([^)]*\\Flagged/, "and the flags are at least as new");
});

test("STORE answers with the version it read before the flags and does not hide a change that came in meanwhile", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX (CONDSTORE)");
	atStatement(w, MODSEQ_READ, async () => {
		w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = 'g1'").run();
		await syncMailbox(w.env, "m1");
	}, "after");
	const store = await client.cmd("STORE 1 +FLAGS (\\Seen)");
	const told = Number(/UID 1 MODSEQ \((\d+)\)/.exec(store.text)?.[1]);
	const current = w.uidRows()[0].modseq;
	assert.ok(told < current);
	assert.match((await client.cmd("NOOP")).text, new RegExp(`MODSEQ \\(${current}\\)`));
});

test("STORE UNCHANGEDSINCE does not write a message the web changed after the check", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const since = w.folder().highest_modseq;
	atStatement(w, MODSEQ_READ, () => w.sqlite.prepare("UPDATE messages SET read = 1 WHERE id = 'g1'").run(), "after");
	const result = await client.cmd(`STORE 1 (UNCHANGEDSINCE ${since}) -FLAGS (\\Seen)`);
	assert.match(result.detail, /^\[MODIFIED 1\]/, "named with the ones that failed the check");
	assert.equal(w.sqlite.prepare("SELECT read FROM messages WHERE id = 'g1'").get().read, 1, "the web's change stands");
	assert.match((await client.cmd("NOOP")).text, /\* 1 FETCH \(FLAGS \(\\Seen\) UID 1 MODSEQ/, "and the client is told about it");
});

test("STORE UNCHANGEDSINCE of an IMAP-only flag is also refused after a change that came in after the check", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const since = w.folder().highest_modseq;
	atStatement(w, MODSEQ_READ, () => w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = 'g1'").run(), "after");
	const result = await client.cmd(`UID STORE 1 (UNCHANGEDSINCE ${since}) +FLAGS (\\Answered \\Seen)`);
	assert.match(result.detail, /^\[MODIFIED 1\]/);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM imap_message_flags").get().n, 0, "no IMAP flag was written");
	assert.equal(w.sqlite.prepare("SELECT read FROM messages WHERE id = 'g1'").get().read, 0);
	const retry = await client.cmd(`UID STORE 1 (UNCHANGEDSINCE ${w.folder().highest_modseq}) +FLAGS (\\Answered)`);
	assert.equal(retry.status, "OK");
	assert.doesNotMatch(retry.detail, /MODIFIED/, "once the client has caught up the same store goes through");
	assert.equal(w.sqlite.prepare("SELECT answered FROM imap_message_flags").get().answered, 1);
});

test("a change that lands during the write of an early group is caught in a late group of the same STORE", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	for (let index = 1; index <= 60; index += 1) w.addMessage({ id: `g${index}` });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const since = w.folder().highest_modseq;
	w.sqlite.exec("CREATE TRIGGER web_change AFTER UPDATE OF read ON messages WHEN NEW.id = 'g1' BEGIN UPDATE messages SET starred = 1 WHERE id = 'g55'; END");
	const result = await client.cmd(`UID STORE 1:60 (UNCHANGEDSINCE ${since}) +FLAGS (\\Seen)`);
	assert.match(result.detail, /^\[MODIFIED 55\]/, "only the message changed meanwhile");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE read = 1").get().n, 59);
	assert.equal(w.sqlite.prepare("SELECT read FROM messages WHERE id = 'g55'").get().read, 0);
});

test("a plain STORE writes whatever changed meanwhile, as before", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	atStatement(w, /^select .* from "messages"/i, () => w.sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = 'g1'").run(), "after");
	assert.equal((await client.cmd("STORE 1 +FLAGS (\\Seen)")).status, "OK");
	assert.deepEqual({ ...w.sqlite.prepare("SELECT read, starred FROM messages WHERE id = 'g1'").get() }, { read: 1, starred: 1 });
});

test("a second SELECT announces the folder that was left as closed, QRESYNC or not", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key, t);
	assert.doesNotMatch((await client.cmd("SELECT INBOX")).text, /CLOSED/);
	assert.match((await client.cmd("SELECT INBOX")).text, /^\* OK \[CLOSED\]/);
});

test("the first use of a mod-sequence feature with a folder selected announces HIGHESTMODSEQ, once", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage();
	const commands = ["ENABLE CONDSTORE", "SEARCH MODSEQ 1", "FETCH 1 (MODSEQ)", "FETCH 1 (FLAGS) (CHANGEDSINCE 1)", "STATUS INBOX (HIGHESTMODSEQ)", "STORE 1 (UNCHANGEDSINCE 99999) +FLAGS (\\Flagged)"];
	for (const command of commands) {
		const client = await loggedIn(w, key, t);
		await client.cmd("SELECT INBOX");
		const known = w.folder().highest_modseq;
		const first = await client.cmd(command);
		assert.equal(first.status, "OK", command);
		assert.match(first.text, new RegExp(`\\* OK \\[HIGHESTMODSEQ ${known}\\]`), command);
		const again = await client.cmd("SEARCH MODSEQ 1");
		assert.doesNotMatch(again.text, /HIGHESTMODSEQ/, `${command}: already on`);
	}
	const unselected = await loggedIn(w, key, t);
	assert.doesNotMatch((await unselected.cmd("STATUS INBOX (HIGHESTMODSEQ)")).text.replace(/\* STATUS[^\r]*\r\n/, ""), /HIGHESTMODSEQ/, "no folder, nothing to announce");
});

test("HIGHESTMODSEQ is never below 1, in SELECT and in STATUS", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key, t);
	assert.match((await client.cmd("STATUS INBOX (HIGHESTMODSEQ)")).text, /HIGHESTMODSEQ [1-9]\d*\)/);
	assert.match((await client.cmd("SELECT INBOX")).text, /\[HIGHESTMODSEQ [1-9]\d*\]/);
	w.sqlite.prepare("UPDATE imap_folder_state SET highest_modseq = 0").run();
	assert.match((await client.cmd("STATUS INBOX (HIGHESTMODSEQ)")).text, /HIGHESTMODSEQ 1\)/);
	assert.match((await client.cmd("SELECT INBOX")).text, /\[HIGHESTMODSEQ 1\]/);
});

test("with QRESYNC on, the tagged answer to EXPUNGE and UID EXPUNGE carries HIGHESTMODSEQ", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	for (let index = 0; index < 4; index += 1) w.addMessage();
	const qres = await loggedIn(w, key, t);
	await qres.cmd("ENABLE QRESYNC");
	await qres.cmd("SELECT INBOX");
	await qres.cmd("UID STORE 2 +FLAGS (\\Deleted)");
	const own = await qres.cmd("EXPUNGE");
	assert.equal(own.detail, `[HIGHESTMODSEQ ${w.folder().highest_modseq}] EXPUNGE completed`);
	await qres.cmd("UID STORE 3 +FLAGS (\\Deleted)");
	const byUid = await qres.cmd("UID EXPUNGE 3");
	assert.equal(byUid.detail, `[HIGHESTMODSEQ ${w.folder().highest_modseq}] UID EXPUNGE completed`);
	const plain = await loggedIn(w, key, t);
	await plain.cmd("SELECT INBOX");
	await plain.cmd("UID STORE 4 +FLAGS (\\Deleted)");
	assert.equal((await plain.cmd("EXPUNGE")).detail, "EXPUNGE completed", "no QRESYNC, no code");
});

test("SEARCH MODSEQ asks the database for the highest mod-sequence instead of loading the folder", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	for (let index = 0; index < 5; index += 1) w.addMessage();
	const client = await loggedIn(w, key, t);
	await client.cmd("SELECT INBOX");
	const seen = recordStatements(w);
	const answer = await client.cmd("SEARCH MODSEQ 1");
	assert.ok(answer.text.includes(`\r\n* SEARCH 1 2 3 4 5 (MODSEQ ${Math.max(...w.uidRows().map((row) => row.modseq))})\r\n`) || answer.text.startsWith(`* SEARCH 1 2 3 4 5 (MODSEQ ${Math.max(...w.uidRows().map((row) => row.modseq))})\r\n`));
	assert.ok(seen.some((sql) => /max\(modseq\)/i.test(sql)));
	assert.ok(!seen.some((sql) => /^SELECT uid, modseq FROM imap_uids WHERE mailbox_id = \? AND folder_key = \?$/.test(sql)), "no read of every mod-sequence of the folder");
});

test("maxModseqOf looks past one chunk of UIDs", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = Array.from({ length: 200 }, () => add());
	await sync();
	sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(ids[150]);
	await sync();
	const top = sqlite.prepare("SELECT max(modseq) AS top FROM imap_uids").get().top;
	assert.equal(await maxModseqOf(env, "m1", "inbox", Array.from({ length: 200 }, (_, index) => index + 1)), top);
	assert.ok(top > 200, "the changed message has the highest one");
	assert.equal(await maxModseqOf(env, "m1", "inbox", [1, 2, 3]), 3 <= top ? sqlite.prepare("SELECT max(modseq) AS top FROM imap_uids WHERE uid <= 3").get().top : 0);
});

test("a log too large for one command is not read at all before the other path is taken", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = Array.from({ length: 12 }, () => add());
	await sync();
	const start = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	for (const id of ids.filter((_, index) => index % 2 === 0)) sqlite.prepare("DELETE FROM messages WHERE id = ?").run(id);
	await sync();
	const view = await openView(env);
	const seen = [];
	const prepare = env.DB.prepare.bind(env.DB);
	env.DB.prepare = (sql) => {
		seen.push(sql);
		return prepare(sql);
	};
	const answer = await vanishedSince(env, view, start, null, 3);
	assert.deepEqual(answer, [[1, 1], [3, 3], [5, 5], [7, 7], [9, 9], [11, 11]]);
	assert.ok(!seen.some((sql) => /^SELECT uid FROM imap_expunged/.test(sql)), "the rows were counted, not paged through");
	seen.length = 0;
	assert.deepEqual(await vanishedSince(env, view, start, null), answer);
	assert.ok(seen.some((sql) => /^SELECT uid FROM imap_expunged/.test(sql)), "a log within the cap is read");
});

test("the answer from the UIDs that exist reads the folder, not the list the session holds", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = Array.from({ length: 6 }, () => add());
	await sync();
	const start = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	const view = await openView(env);
	sqlite.prepare("DELETE FROM messages WHERE id IN (?, ?)").run(ids[2], ids[4]);
	add();
	await sync();
	assert.equal(view.uids.length, 6, "the session has not refreshed");
	assert.deepEqual(await vanishedSince(env, view, start, null), [[3, 3], [5, 5]], "from the log");
	assert.deepEqual(await vanishedSince(env, view, start, null, 1), [[3, 3], [5, 5]], "from the folder: the same answer");
});

test("a JMAP request cannot make Email/set conditional: the guard is only for the IMAP server", async (t) => {
	const w = await world(t);
	w.addMessage({ id: "g1" });
	const user = { id: "u1", email: "me@example.test", role: "user" };
	const ctx = { env: w.env, db: getDb(w.env), auth: { userId: "u1", email: user.email, scopes: ["jmap"], mailboxIds: null, user }, accountId: "u1", origin: "http://test", createdIds: {} };
	const response = await processRequest(ctx, { using: [], methodCalls: [["Email/set", { update: { g1: { "keywords/$seen": true } }, ifUnchangedSince: { mailboxId: "m1", jmapSeq: 0 } }, "a"]] });
	const [name, body] = response.methodResponses[0];
	assert.equal(name, "Email/set");
	assert.deepEqual(body.updated, { g1: null }, "the argument is not read from a request");
	assert.equal(w.sqlite.prepare("SELECT read FROM messages WHERE id = 'g1'").get().read, 1);
});

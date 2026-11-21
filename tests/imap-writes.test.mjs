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
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-writes-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { ImapServer } from "./server/imap/server.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { clearLoginAuditMemory } from "./src/lib/imap/auth.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { openFileBucket } from "./server/runtime/file-bucket.ts";
			export { openRateLimiter } from "./server/runtime/misc.ts";
			export { rememberSubmission, clearSubmissionMemory } from "./src/lib/imap/sent-dedupe.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-protocol-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { ImapServer, rememberSubmission, clearSubmissionMemory, generateAppPassword, clearApiKeyVerificationCache, clearLoginAuditMemory, SqliteDatabase, applyMigrations, openFileBucket, openRateLimiter } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

// A throwaway certificate for 127.0.0.1 / localhost, made once for the file.
const keyPath = join(directory, "key.pem");
const certPath = join(directory, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
const certificate = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
const ca = certificate.cert;

const RAW_ALTERNATIVE = [
	"From: =?UTF-8?B?w4RuZHJpcw==?= <a@x.test>",
	'To: me@example.test, "C D" <c@x.test>',
	"Subject: Hello there",
	"Date: Mon, 1 Jan 2024 10:00:00 +0000",
	"Message-ID: <m1@x.test>",
	"MIME-Version: 1.0",
	'Content-Type: multipart/alternative; boundary="A"',
	"",
	"--A",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"plain body",
	"--A",
	"Content-Type: text/html",
	"",
	"<p>html body</p>",
	"--A--",
	"",
].join("\r\n");

async function world(t, options = {}) {
	clearApiKeyVerificationCache();
	clearLoginAuditMemory();
	const database = new SqliteDatabase(":memory:");
	const bucketDir = mkdtempSync(join(directory, "blobs-"));
	const bucket = openFileBucket(bucketDir);
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
	const addRaw = async (id, raw, overrides = {}) => {
		await bucket.put(`raw/${id}.eml`, raw);
		return helpers.addMessage({ id, raw_r2_key: `raw/${id}.eml`, ...overrides });
	};
	return { ...helpers, sqlite, env, server, ports, bucket, addRaw, open: () => connectTlsClient(ports.tlsPort, ca) };
}

async function loggedIn(w, key, user = "me@example.test") {
	const client = await w.open();
	await client.greeting();
	const result = await client.login(user, key.fullKey);
	assert.equal(result.status, "OK", result.text);
	return client;
}

const flagsOf = (w, id) => w.sqlite.prepare("SELECT answered, forwarded, deleted, keywords FROM imap_message_flags WHERE message_id = ?").get(id);

test("SELECT is read-write with the flags a client may set; EXAMINE and a read-only delegation are read-only", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "s1", mailbox_id: "ms", to_addr: "team@other.test" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const select = await client.cmd("SELECT INBOX");
	assert.match(select.text, /\* FLAGS \(\\Answered \\Flagged \\Deleted \\Seen \\Draft \$Forwarded\)\r\n/);
	assert.match(select.text, /\* OK \[PERMANENTFLAGS \(\\Answered \\Flagged \\Deleted \\Seen \$Forwarded \\\*\)\] Limited\r\n/);
	assert.equal(select.detail, "[READ-WRITE] SELECT completed");
	const examine = await client.cmd("EXAMINE INBOX");
	assert.equal(examine.detail, "[READ-ONLY] EXAMINE completed");
	assert.match(examine.text, /PERMANENTFLAGS \(\)/);
	assert.equal((await client.cmd("STORE 1 +FLAGS (\\Seen)")).detail, "[NOPERM] The mailbox is read-only");
	const shared = await client.cmd("SELECT Shared/team@other.test/INBOX");
	assert.equal(shared.detail, "[READ-ONLY] SELECT completed");
	assert.equal((await client.cmd("STORE 1 +FLAGS (\\Seen)")).detail, "[NOPERM] The mailbox is read-only");
	assert.equal((await client.cmd("UID STORE 1 +FLAGS (\\Seen)")).status, "NO");
	assert.equal(w.sqlite.prepare("SELECT read FROM messages WHERE id = 's1'").get().read, 0);
});

test("STORE: +FLAGS, -FLAGS and FLAGS on \\Seen and \\Flagged change the message, and the answer lists the flags", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	w.addMessage({ id: "g2", read: 1 });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const add = await client.cmd("STORE 1 +FLAGS (\\Seen \\Flagged)");
	assert.match(add.text, /^\* 1 FETCH \(FLAGS \(\\Seen \\Flagged\) UID 1\)\r\n/);
	assert.deepEqual({ ...w.sqlite.prepare("SELECT read, starred FROM messages WHERE id = 'g1'").get() }, { read: 1, starred: 1 });
	const remove = await client.cmd("UID STORE 1:2 -FLAGS (\\Seen)");
	assert.match(remove.text, /\* 1 FETCH \(FLAGS \(\\Flagged\) UID 1\)\r\n\* 2 FETCH \(FLAGS \(\) UID 2\)\r\n/);
	assert.equal(w.sqlite.prepare("SELECT read FROM messages WHERE id = 'g2'").get().read, 0);
	const replace = await client.cmd("STORE 2 FLAGS (\\Flagged)");
	assert.match(replace.text, /\* 2 FETCH \(FLAGS \(\\Flagged\) UID 2\)/);
	const silent = await client.cmd("STORE 1 -FLAGS.SILENT (\\Flagged)");
	assert.doesNotMatch(silent.text, /FETCH/);
	assert.equal(w.sqlite.prepare("SELECT starred FROM messages WHERE id = 'g1'").get().starred, 0);
	// What the client changed itself is not announced again.
	assert.doesNotMatch((await client.cmd("NOOP")).text, /FETCH/);
});

test("STORE: \\Answered, $Forwarded, \\Deleted and keywords are kept per message and give the UID a new mod-sequence", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const before = w.sqlite.prepare("SELECT modseq FROM imap_uids WHERE message_id = 'g1'").get().modseq;
	const result = await client.cmd("STORE 1 +FLAGS (\\Answered $forwarded \\Deleted $Junk Orders orders)");
	assert.match(result.text, /\* 1 FETCH \(FLAGS \(\\Answered \\Deleted \$Forwarded \$Junk Orders\) UID 1\)/);
	assert.deepEqual({ ...flagsOf(w, "g1") }, { answered: 1, forwarded: 1, deleted: 1, keywords: '["$Junk","Orders"]' });
	const after = w.sqlite.prepare("SELECT modseq FROM imap_uids WHERE message_id = 'g1'").get().modseq;
	assert.ok(after > before, "the UID has a later mod-sequence");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM imap_uids WHERE message_id = 'g1'").get().n, 1, "same UID");
	await client.cmd("STORE 1 -FLAGS (ORDERS $Forwarded)");
	assert.deepEqual({ ...flagsOf(w, "g1") }, { answered: 1, forwarded: 0, deleted: 1, keywords: '["$Junk"]' });
	await client.cmd("STORE 1 FLAGS (\\Seen)");
	assert.deepEqual({ ...flagsOf(w, "g1") }, { answered: 0, forwarded: 0, deleted: 0, keywords: "[]" });
});

test("STORE checks flags: bad atoms are refused, \\Draft is ignored, more than 50 keywords is a limit", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	w.addMessage({ id: "d1", status: "draft", direction: "outbound" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	assert.equal((await client.cmd('STORE 1 +FLAGS ("a b")')).status, "BAD");
	assert.equal((await client.cmd(`STORE 1 +FLAGS (${"k".repeat(65)})`)).status, "BAD");
	assert.equal((await client.cmd("STORE 1 +FLAGS ((x))")).status, "BAD");
	assert.equal((await client.cmd("STORE 1 +FLAGS (a) extra")).status, "BAD");
	assert.equal((await client.cmd("STORE 1 BOGUS (a)")).status, "BAD");
	assert.equal((await client.cmd("STORE 1 +FLAGS (\\Draft \\Recent \\Nonsense)")).status, "OK");
	assert.equal(w.sqlite.prepare("SELECT status FROM messages WHERE id = 'g1'").get().status, "received");
	assert.equal(flagsOf(w, "g1"), undefined, "nothing was stored for ignored flags");
	const fifty = Array.from({ length: 50 }, (_, i) => `k${i}`).join(" ");
	assert.equal((await client.cmd(`STORE 1 +FLAGS (${fifty})`)).status, "OK");
	const over = await client.cmd("STORE 1 +FLAGS (one-more)");
	assert.deepEqual([over.status, over.detail], ["NO", "[LIMIT] A message would have more than 50 keywords"]);
	assert.equal(JSON.parse(flagsOf(w, "g1").keywords).length, 50);
	assert.equal((await client.cmd("STORE 9 +FLAGS (\\Seen)")).status, "OK", "a number past the end selects nothing");
	assert.equal((await client.cmd("STORE 0 +FLAGS (\\Seen)")).status, "BAD");
});

test("STORE leaves a message another client filed elsewhere alone, and never writes back a stale read state", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	w.addMessage({ id: "g2" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	// The web app files g1 in Trash after this session last looked at the folder.
	w.sqlite.prepare("UPDATE messages SET status = 'trash' WHERE id = 'g1'").run();
	const stale = await client.cmd("STORE 1:2 +FLAGS (\\Deleted)");
	assert.equal(stale.status, "OK");
	assert.equal(flagsOf(w, "g1"), undefined, "the message that left the folder got no flag");
	assert.equal(flagsOf(w, "g2").deleted, 1);
	assert.equal(w.sqlite.prepare("SELECT status FROM messages WHERE id = 'g1'").get().status, "trash");
	// A read change made on the web while the STORE is writing is not undone by it.
	w.sqlite.exec("CREATE TRIGGER web_marks_read BEFORE INSERT ON imap_message_flags BEGIN UPDATE messages SET read = 1 WHERE id = NEW.message_id; END;");
	await client.cmd("UID STORE 2 +FLAGS (\\Answered)");
	assert.equal(w.sqlite.prepare("SELECT read FROM messages WHERE id = 'g2'").get().read, 1);
	assert.equal(flagsOf(w, "g2").answered, 1);
});

test("a flag change reaches a second session that is in IDLE", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const first = await loggedIn(w, key);
	const second = await loggedIn(w, key);
	t.after(() => { first.end(); second.end(); });
	await first.cmd("SELECT INBOX");
	await second.cmd("SELECT INBOX");
	second.write("i1 IDLE\r\n");
	await second.expect("+ idling\r\n");
	await first.cmd("STORE 1 +FLAGS (\\Seen \\Answered)");
	await second.expect("* 1 FETCH (FLAGS (\\Seen \\Answered) UID 1)\r\n", 4000);
	second.write("DONE\r\n");
	await second.finish("i1");
});

test("fetching a body without PEEK sets \\Seen and says so; PEEK, headers-only items and read-only sessions do not", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	for (const id of ["g1", "g2", "g3", "g4"]) w.addMessage({ id });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const read = (id) => w.sqlite.prepare("SELECT read FROM messages WHERE id = ?").get(id).read;
	await client.cmd("FETCH 1 BODY.PEEK[]");
	await client.cmd("FETCH 1 (FLAGS ENVELOPE)");
	assert.equal(read("g1"), 0);
	const fetched = await client.cmd("FETCH 1 BODY[TEXT]");
	assert.match(fetched.text, /FLAGS \(\\Seen\)/);
	assert.equal(read("g1"), 1);
	await client.cmd("FETCH 2 RFC822");
	assert.equal(read("g2"), 1);
	await client.cmd("FETCH 3 RFC822.HEADER");
	assert.equal(read("g3"), 0, "RFC822.HEADER is a peek");
	await client.cmd("EXAMINE INBOX");
	await client.cmd("FETCH 3 BODY[]");
	assert.equal(read("g3"), 0, "EXAMINE never sets flags");
	await client.cmd("SELECT INBOX");
	assert.doesNotMatch((await client.cmd("NOOP")).text, /FETCH/, "the \\Seen sent with the fetch is not repeated");
});

test("a fetch that stops at its byte budget marks read only the messages it sent", async (t) => {
	const w = await world(t, { maxFetchBytes: Buffer.byteLength(RAW_ALTERNATIVE) * 1.5 });
	const key = await w.addKey({ id: "k1" });
	for (const id of ["g1", "g2", "g3"]) await w.addRaw(id, RAW_ALTERNATIVE);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const result = await client.cmd("FETCH 1:3 BODY[]");
	assert.equal(result.status, "NO");
	assert.match(result.detail, /^\[LIMIT\]/);
	assert.match(result.text, /^\* 1 FETCH \(BODY\[\] \{\d+\}[\s\S]*FLAGS \(\\Seen\)\)\r\n/);
	assert.doesNotMatch(result.text, /\* 2 FETCH/);
	const read = (id) => w.sqlite.prepare("SELECT read FROM messages WHERE id = ?").get(id).read;
	assert.deepEqual(["g1", "g2", "g3"].map(read), [1, 0, 0]);
});

// ---- MOVE, COPY, EXPUNGE ----

const statusOf = (w, id) => w.sqlite.prepare("SELECT status, folder_id AS folder, mailbox_id AS mailbox, user_id AS user FROM messages WHERE id = ?").get(id);
const uidsIn = (w, mailbox, key) => w.sqlite.prepare("SELECT uid, message_id AS id FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? ORDER BY uid").all(mailbox, key);
const addFolder = (w, id, name, mailbox = "m1") => w.sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES (?, 'u1', ?, ?, 1)").run(id, mailbox, name);

test("the capability list names UIDPLUS and MOVE after login", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.match((await client.cmd("CAPABILITY")).text, /\* CAPABILITY .*\bUIDPLUS\b.*\bMOVE\b/);
});

test("MOVE files the messages in the folder, answers COPYUID and EXPUNGE, clears \\Deleted and the snooze", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1", snoozed_until: 4_000_000_000 });
	w.addMessage({ id: "g2" });
	addFolder(w, "f1", "Clients/Acme");
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	await client.cmd("STORE 1 +FLAGS (\\Deleted \\Answered)");
	const moved = await client.cmd("MOVE 1 Archive");
	assert.match(moved.text, /^\* OK \[COPYUID \d+ 1 1\] Moved\r\n\* 1 EXPUNGE\r\n/);
	assert.equal(moved.status, "OK");
	assert.deepEqual({ ...statusOf(w, "g1") }, { status: "archived", folder: null, mailbox: "m1", user: "u1" });
	assert.equal(flagsOf(w, "g1").deleted, 0, "\\Deleted is cleared on move");
	assert.equal(flagsOf(w, "g1").answered, 1, "other flags follow the message");
	assert.deepEqual(uidsIn(w, "m1", "archive").map((row) => row.id), ["g1"]);
	assert.deepEqual(uidsIn(w, "m1", "inbox").map((row) => row.id), ["g2"]);
	const folder = await client.cmd('UID MOVE 2 "Clients/Acme"');
	assert.match(folder.text, /\* OK \[COPYUID \d+ 2 1\] Moved\r\n\* 1 EXPUNGE\r\n/);
	assert.deepEqual({ ...statusOf(w, "g2") }, { status: "received", folder: "f1", mailbox: "m1", user: "u1" });
	assert.equal((await client.cmd("MOVE 1 Archive")).status, "OK", "nothing left to move");
	await client.cmd("SELECT Archive");
	await client.cmd("MOVE 1 INBOX");
	assert.equal(w.sqlite.prepare("SELECT snoozed_until FROM messages WHERE id = 'g1'").get().snoozed_until, null, "back in the inbox the snooze is gone, as the web UI's Move to inbox does");
});

test("MOVE is all or nothing: one message that may not go there stops the whole command", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1", direction: "outbound", status: "received" });
	w.addMessage({ id: "g2" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const refused = await client.cmd("MOVE 1:2 Sent");
	assert.deepEqual([refused.status, refused.detail], ["NO", "[CANNOT] Received mail cannot be moved to Sent"]);
	assert.equal(statusOf(w, "g1").status, "received");
	assert.equal(statusOf(w, "g2").status, "received");
	assert.equal((await client.cmd("MOVE 1 INBOX")).detail, "[CANNOT] The messages are already in that folder");
	assert.equal((await client.cmd("MOVE 1 Nowhere")).detail, "[TRYCREATE] Mailbox does not exist");
	assert.equal((await client.cmd("MOVE 1 Shared")).detail, "[TRYCREATE] Mailbox does not exist", "a placeholder is no destination");
});

test("moving to Junk and back is the web UI's spam and not-spam: the filter learns from it", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	await client.cmd("MOVE 1 Junk");
	assert.equal(statusOf(w, "g1").status, "spam");
	assert.equal(w.sqlite.prepare("SELECT classification FROM spam_feedback WHERE message_id = 'g1'").get().classification, "spam");
	await client.cmd("SELECT Junk");
	await client.cmd("MOVE 1 INBOX");
	assert.equal(statusOf(w, "g1").status, "received");
	assert.equal(w.sqlite.prepare("SELECT classification FROM spam_feedback WHERE message_id = 'g1'").get().classification, "ham");
});

test("MOVE and COPY need write permission on both folders", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	w.addMessage({ id: "s1", mailbox_id: "ms", to_addr: "team@other.test" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	assert.equal((await client.cmd("COPY 1 Shared/team@other.test/INBOX")).detail, "[NOPERM] The mailbox is read-only");
	assert.equal((await client.cmd("MOVE 1 Shared/team@other.test/Archive")).detail, "[NOPERM] The mailbox is read-only");
	await client.cmd("SELECT Shared/team@other.test/INBOX");
	assert.equal((await client.cmd("MOVE 1 Archive")).detail, "[NOPERM] The mailbox is read-only");
	assert.equal((await client.cmd("EXPUNGE")).detail, "[NOPERM] The mailbox is read-only");
	assert.equal(statusOf(w, "s1").status, "received");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
});

test("COPY duplicates the row, the raw bytes and the attachments, keeps the flags, and answers COPYUID", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE, { read: 1, starred: 1, thread_id: "t1" });
	await w.bucket.put("attachments/g1/a1/f.txt", "attachment bytes");
	w.sqlite.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('a1', 'g1', 'f.txt', 'text/plain', 16, 'attachment', 'attachments/g1/a1/f.txt', 1)").run();
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	await client.cmd("STORE 1 +FLAGS (\\Answered Orders)");
	const copied = await client.cmd("COPY 1 Archive");
	assert.match(copied.detail, /^\[COPYUID \d+ 1 1\] COPY completed$/);
	assert.doesNotMatch(copied.text, /EXPUNGE/, "the original stays");
	const [copy] = w.sqlite.prepare("SELECT * FROM messages WHERE id != 'g1'").all();
	assert.equal(copy.status, "archived");
	assert.equal(copy.read, 1);
	assert.equal(copy.starred, 1);
	assert.equal(copy.thread_id, "t1");
	assert.equal(copy.subject, "subject g1");
	assert.notEqual(copy.raw_r2_key, "raw/g1.eml");
	assert.equal(Buffer.from(await (await w.bucket.get(copy.raw_r2_key)).arrayBuffer()).toString(), RAW_ALTERNATIVE);
	assert.ok(await w.bucket.get("raw/g1.eml"), "the original object is untouched");
	const [attachment] = w.sqlite.prepare("SELECT * FROM message_attachments WHERE message_id = ?").all(copy.id);
	assert.notEqual(attachment.r2_key, "attachments/g1/a1/f.txt");
	assert.equal(Buffer.from(await (await w.bucket.get(attachment.r2_key)).arrayBuffer()).toString(), "attachment bytes");
	assert.deepEqual({ ...flagsOf(w, copy.id) }, { answered: 1, forwarded: 0, deleted: 0, keywords: '["Orders"]' });
	assert.deepEqual(uidsIn(w, "m1", "archive").map((row) => row.id), [copy.id]);
	const again = await client.cmd("UID COPY 1 INBOX");
	assert.match(again.detail, /^\[COPYUID \d+ 1 2\]/, "a copy into the same folder is a second message");
	assert.equal((await client.cmd("COPY 1 Nowhere")).detail, "[TRYCREATE] Mailbox does not exist");
});

test("COPY into Trash of the same mailbox moves the message instead of filling Trash with copies", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const result = await client.cmd("COPY 1 Trash");
	assert.match(result.detail, /^\[COPYUID \d+ 1 1\]/);
	assert.match(result.text, /\* 1 EXPUNGE/);
	assert.equal(statusOf(w, "g1").status, "trash");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
});

test("COPY into another mailbox the login may write creates the row there, owned by that mailbox's owner", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.sqlite.prepare("UPDATE mailbox_access SET permission = 'full_access'").run();
	await w.addRaw("g1", RAW_ALTERNATIVE);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	assert.match((await client.cmd("COPY 1 Shared/team@other.test/Archive")).detail, /^\[COPYUID \d+ 1 1\]/);
	const [copy] = w.sqlite.prepare("SELECT * FROM messages WHERE id != 'g1'").all();
	assert.deepEqual([copy.mailbox_id, copy.user_id, copy.status, copy.thread_id], ["ms", "u2", "archived", null]);
	const moved = await client.cmd("MOVE 1 Shared/team@other.test/INBOX");
	assert.match(moved.text, /\[COPYUID \d+ 1 1\] Moved/);
	assert.equal(statusOf(w, "g1").status, "trash", "the source is kept in its own Trash, not destroyed");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE mailbox_id = 'ms'").get().n, 2);
});

test("EXPUNGE removes only what is \\Deleted in the selected folder: to Trash from other folders, for good from Trash and Drafts", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	w.addMessage({ id: "g2" });
	w.addMessage({ id: "g3" });
	await w.addRaw("t1", RAW_ALTERNATIVE, { status: "trash" });
	await w.addRaw("t2", RAW_ALTERNATIVE, { status: "trash" });
	w.addMessage({ id: "d1", status: "draft", direction: "outbound" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	await client.cmd("STORE 1,3 +FLAGS (\\Deleted)");
	const expunged = await client.cmd("EXPUNGE");
	assert.match(expunged.text, /^\* 3 EXPUNGE\r\n\* 1 EXPUNGE\r\n/);
	assert.equal(statusOf(w, "g1").status, "trash");
	assert.equal(statusOf(w, "g3").status, "trash");
	assert.equal(statusOf(w, "g2").status, "received", "not flagged, not touched");
	assert.equal(flagsOf(w, "g1").deleted, 0, "the message in Trash is not flagged any more");
	assert.doesNotMatch((await client.cmd("EXPUNGE")).text, /\* \d+ EXPUNGE/, "nothing is flagged now");
	await client.cmd("SELECT Trash");
	const trash = uidsIn(w, "m1", "trash");
	assert.equal(trash.length, 4);
	await client.cmd(`UID STORE ${trash.map((row) => row.uid).join(",")} +FLAGS (\\Deleted)`);
	await client.cmd(`UID EXPUNGE ${trash.find((row) => row.id === "t1").uid}`);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id = 't1'").get().n, 0, "gone for good");
	assert.equal(await w.bucket.get("raw/t1.eml"), null, "with its raw object");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id IN ('t2', 'g1', 'g3')").get().n, 3, "UID EXPUNGE took only its set");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'email.delete' AND metadata LIKE '%\"permanent\":true%'").get().n, 1);
	await client.cmd("SELECT Drafts");
	await client.cmd("STORE 1 +FLAGS (\\Deleted)");
	await client.cmd("EXPUNGE");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id = 'd1'").get().n, 0);
	assert.equal((await client.cmd("UID EXPUNGE")).status, "BAD");
	assert.equal((await client.cmd("UID EXPUNGE 1:x")).status, "BAD");
});

test("CLOSE removes the \\Deleted messages without EXPUNGE responses; EXAMINE then CLOSE and UNSELECT remove nothing", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	w.addMessage({ id: "g2" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	await client.cmd("STORE 1 +FLAGS (\\Deleted)");
	assert.equal((await client.cmd("UNSELECT")).status, "OK");
	assert.equal(statusOf(w, "g1").status, "received");
	await client.cmd("EXAMINE INBOX");
	assert.doesNotMatch((await client.cmd("CLOSE")).text, /\* \d+ EXPUNGE/);
	assert.equal(statusOf(w, "g1").status, "received");
	await client.cmd("SELECT INBOX");
	const closed = await client.cmd("CLOSE");
	assert.doesNotMatch(closed.text, /EXPUNGE/);
	assert.equal(statusOf(w, "g1").status, "trash");
	assert.equal(statusOf(w, "g2").status, "received");
});

test("a second session sees a MOVE and an EXPUNGE done by the first", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	w.addMessage({ id: "g2" });
	const first = await loggedIn(w, key);
	const second = await loggedIn(w, key);
	t.after(() => { first.end(); second.end(); });
	await first.cmd("SELECT INBOX");
	await second.cmd("SELECT INBOX");
	second.write("i1 IDLE\r\n");
	await second.expect("+ idling\r\n");
	await first.cmd("MOVE 2 Archive");
	await second.expect("* 2 EXPUNGE\r\n", 4000);
	second.write("DONE\r\n");
	await second.finish("i1");
});

// ---- APPEND ----

const mail = ({ from = "me@example.test", to = "c@x.test", subject = "Appended", id = "<ap1@x.test>", extra = "", body = "appended body" } = {}) =>
	`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\nMessage-ID: ${id}\r\n${extra}\r\n${body}\r\n`;

/** APPEND with a synchronising literal: wait for the continuation, send the bytes, finish. */
async function append(client, folder, raw, { flags = "", date = "", plus = false } = {}) {
	const bytes = Buffer.from(raw, "latin1");
	const tag = `p${++client.counter}`;
	client.write(`${tag} APPEND ${folder}${flags ? ` (${flags})` : ""}${date ? ` "${date}"` : ""} {${bytes.length}${plus ? "+" : ""}}\r\n`);
	if (!plus) await client.expect("+ Ready\r\n", 4000);
	client.write(`${raw}\r\n`);
	return client.finish(tag, 8000);
}
const rowOf = (w, where) => w.sqlite.prepare(`SELECT * FROM messages WHERE ${where}`).get();

test("the capability list carries APPENDLIMIT after login, not before", async (t) => {
	const w = await world(t, { maxMessageSize: 123456 });
	const key = await w.addKey({ id: "k1" });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	assert.doesNotMatch((await client.cmd("CAPABILITY")).text, /APPENDLIMIT/);
	await client.login("me@example.test", key.fullKey);
	assert.match((await client.cmd("CAPABILITY")).text, /\bAPPENDLIMIT=123456\b/);
});

test("APPEND to INBOX stores the bytes as they came, with the flags and internal date, and answers APPENDUID", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const raw = mail({ from: "sender@x.test", subject: "Plain", id: "<one@x.test>", extra: "X-Odd: caf\xe9\r\n" });
	const result = await append(client, "INBOX", raw, { flags: "\\Seen \\Flagged \\Answered Orders", date: " 2-Feb-2024 10:00:00 +0100" });
	assert.match(result.detail, /^\[APPENDUID \d+ 1\] APPEND completed$/);
	const row = rowOf(w, "subject = 'Plain'");
	assert.deepEqual([row.status, row.folder_id, row.direction, row.read, row.starred, row.mailbox_id, row.user_id, row.provider_message_id, row.from_addr], ["received", null, "inbound", 1, 1, "m1", "u1", "<one@x.test>", "sender@x.test"]);
	assert.equal(row.created_at, Date.UTC(2024, 1, 2, 9, 0, 0) / 1000, "the internal date wins over the Date header");
	assert.equal(Buffer.from(await (await w.bucket.get(row.raw_r2_key)).arrayBuffer()).toString("latin1"), raw, "stored verbatim");
	assert.deepEqual({ ...flagsOf(w, row.id) }, { answered: 1, forwarded: 0, deleted: 0, keywords: '["Orders"]' });
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM imap_uids WHERE message_id = ? AND folder_key = 'inbox'").get(row.id).n, 1);
	await client.cmd("SELECT INBOX");
	assert.match((await client.cmd("FETCH 1 (FLAGS RFC822.SIZE)")).text, new RegExp(`FLAGS \\(\\\\Seen \\\\Flagged \\\\Answered Orders\\) RFC822.SIZE ${raw.length}\\)`));
	const unread = await append(client, "INBOX", mail({ subject: "Unread", id: "<two@x.test>" }), { plus: true });
	assert.match(unread.detail, /^\[APPENDUID \d+ 2\]/, "a non-synchronising literal works too");
	assert.equal(rowOf(w, "subject = 'Unread'").read, 0);
});

test("APPEND picks the placement by folder: Archive, Junk, Trash, Sent and user folders; unknown folders are TRYCREATE", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	addFolder(w, "f1", "Clients/Acme");
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const placed = [["Archive", "archived", null, "inbound"], ["Junk", "spam", null, "inbound"], ["Trash", "trash", null, "inbound"], ["Sent", "sent", null, "outbound"], ['"Clients/Acme"', "received", "f1", "inbound"]];
	for (const [index, [folder, status, folderId, direction]] of placed.entries()) {
		const result = await append(client, folder, mail({ subject: `to ${index}`, id: `<p${index}@x.test>` }));
		assert.equal(result.status, "OK", `${folder}: ${result.detail}`);
		const row = rowOf(w, `subject = 'to ${index}'`);
		assert.deepEqual([row.status, row.folder_id, row.direction], [status, folderId, direction], folder);
	}
	assert.equal(rowOf(w, "subject = 'to 3'").read, 1, "a sent copy is read");
	const missing = await append(client, "Nowhere", mail());
	assert.deepEqual([missing.status, missing.detail], ["NO", "[TRYCREATE] Mailbox does not exist"]);
	assert.equal((await append(client, "Shared", mail())).detail, "[TRYCREATE] Mailbox does not exist");
});

test("APPEND to Drafts keeps the bytes under drafts/, makes a draft row, and needs a sender the login may use", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const raw = mail({ subject: "My draft", id: "<d1@x.test>", body: "draft body" });
	const result = await append(client, "Drafts", raw, { flags: "\\Seen \\Draft" });
	assert.match(result.detail, /^\[APPENDUID \d+ 1\]/);
	const row = rowOf(w, "subject = 'My draft'");
	assert.deepEqual([row.status, row.direction, row.mailbox_id, row.read, row.raw_r2_key, row.from_addr], ["draft", "outbound", "m1", 1, `drafts/${row.id}.eml`, '"One" <me@example.test>']);
	assert.equal(Buffer.from(await (await w.bucket.get(row.raw_r2_key)).arrayBuffer()).toString("latin1"), raw);
	await client.cmd("SELECT Drafts");
	const fetched = await client.cmd("FETCH 1 BODY.PEEK[TEXT]");
	assert.ok(fetched.text.includes(Buffer.from("draft body\r\n").toString("base64")), "a draft is served synthesized from its columns");
	const foreign = await append(client, "Drafts", mail({ from: "someone@else.test", subject: "Foreign" }));
	assert.deepEqual([foreign.status, foreign.detail.split("]")[0]], ["NO", "[NOPERM"]);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE subject = 'Foreign'").get().n, 0);
});

test("APPEND to Sent is not stored again when the submission service already sent that Message-ID", async (t) => {
	clearSubmissionMemory();
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "sent1", direction: "outbound", status: "sent", from_addr: "me@example.test" });
	const client = await loggedIn(w, key);
	t.after(() => { client.end(); clearSubmissionMemory(); });
	await client.cmd("SELECT Sent");
	rememberSubmission("u1", "<dup@x.test>", "sent1", "m1");
	const result = await append(client, "Sent", mail({ id: "<dup@x.test>", subject: "Same" }));
	assert.match(result.detail, /^\[APPENDUID \d+ 1\]/, "the UID of the row that is already there");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE mailbox_id = 'm1'").get().n, 1);
	const other = await append(client, "Sent", mail({ id: "<other@x.test>", subject: "Different" }));
	assert.match(other.detail, /^\[APPENDUID \d+ 2\]/);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE mailbox_id = 'm1'").get().n, 2);
	// Another user's submission with the same Message-ID does not hide this user's copy.
	rememberSubmission("u2", "<third@x.test>", "sent1", "m1");
	assert.match((await append(client, "Sent", mail({ id: "<third@x.test>", subject: "Third" }))).detail, /^\[APPENDUID \d+ 3\]/);
	// After the window the same id is stored again.
	rememberSubmission("u1", "<old@x.test>", "sent1", "m1", Date.now() - 16 * 60 * 1000);
	assert.match((await append(client, "Sent", mail({ id: "<old@x.test>", subject: "Late" }))).detail, /^\[APPENDUID \d+ 4\]/);
});

test("APPEND into a shared mailbox needs permission there, and the row belongs to that mailbox's owner", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const denied = await append(client, "Shared/team@other.test/INBOX", mail());
	assert.deepEqual([denied.status, denied.detail], ["NO", "[NOPERM] The mailbox is read-only"]);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
	w.sqlite.prepare("UPDATE mailbox_access SET permission = 'send_as'").run();
	const ok = await append(client, "Shared/team@other.test/INBOX", mail({ subject: "Team" }));
	assert.equal(ok.status, "OK", ok.detail);
	assert.deepEqual([rowOf(w, "subject = 'Team'").mailbox_id, rowOf(w, "subject = 'Team'").user_id], ["ms", "u2"]);
	assert.equal((await append(client, "Shared/two@other.test/INBOX", mail())).detail, "[TRYCREATE] Mailbox does not exist", "another user's mailbox cannot be named");
});

test("APPEND checks its arguments and flags", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.equal((await client.cmd('APPEND INBOX "just a string"')).detail, "APPEND needs the message as a literal");
	assert.equal((await append(client, "INBOX", mail(), { date: "31-Feb-2024 10:00:00 +0000" })).status, "BAD");
	assert.equal((await append(client, "INBOX", mail(), { date: "yesterday" })).status, "BAD");
	assert.equal((await append(client, "INBOX", mail(), { flags: '"a b"' })).status, "BAD");
	const many = Array.from({ length: 51 }, (_, i) => `k${i}`).join(" ");
	assert.deepEqual((({ status, detail }) => [status, detail])(await append(client, "INBOX", mail(), { flags: many })), ["NO", "[LIMIT] A message may have at most 50 keywords"]);
	client.write("e1 APPEND INBOX {0+}\r\n\r\n");
	assert.deepEqual((({ status, detail }) => [status, detail])(await client.finish("e1")), ["NO", "[CANNOT] The message is empty"]);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
	assert.equal((await client.cmd("NOOP")).status, "OK");
});

test("what a message says in its headers cannot start a new header in a stored column", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const evil = mail({ subject: "=?utf-8?q?hello=0D=0ABcc:_victim@x.test=0D=0AX-Evil:_1?=", extra: "Reply-To: =?utf-8?q?a@x.test=0D=0ABcc:_v@x.test?=\r\n" });
	assert.equal((await append(client, "INBOX", evil)).status, "OK");
	const row = rowOf(w, "mailbox_id = 'm1'");
	for (const column of ["subject", "from_addr", "to_addr", "cc_addr", "bcc_addr", "reply_to", "provider_message_id", "in_reply_to", "references_header"]) {
		assert.doesNotMatch(String(row[column] ?? ""), /[\r\n\0]/, column);
	}
	assert.equal(Buffer.from(await (await w.bucket.get(row.raw_r2_key)).arrayBuffer()).toString("latin1"), evil, "the stored bytes are exactly what was sent");
});

test("an APPEND bigger than the limit is refused with [TOOBIG]: before the continuation, or thrown away if it is already on its way", async (t) => {
	const w = await world(t, { maxMessageSize: 2000 });
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	client.write("a1 APPEND INBOX {2001}\r\n");
	const refused = await client.finish("a1");
	assert.deepEqual([refused.status, refused.detail], ["NO", "[TOOBIG] The message is larger than this server accepts"]);
	assert.doesNotMatch(refused.text, /\+ Ready/);
	const big = mail({ body: "x".repeat(300_000) });
	client.write(`a2 APPEND INBOX {${big.length}+}\r\n${big}\r\n`);
	assert.equal((await client.finish("a2")).detail, "[TOOBIG] The message is larger than this server accepts");
	assert.equal((await client.cmd("NOOP")).status, "OK", "the bytes were discarded and the connection is in step");
	assert.equal((await append(client, "INBOX", mail({ body: "x".repeat(1000) }))).status, "OK");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
	assert.equal(w.server.appendBytesInFlight, 0);
});

test("the process-wide budget of in-flight APPEND data refuses the next message as busy and is given back afterwards", async (t) => {
	const w = await world(t, { maxMessageSize: 1000, appendBudget: 1500 });
	const key = await w.addKey({ id: "k1" });
	const first = await loggedIn(w, key);
	const second = await loggedIn(w, key);
	t.after(() => { first.end(); second.end(); });
	first.write("a1 APPEND INBOX {1000}\r\n");
	await first.expect("+ Ready\r\n");
	assert.equal(w.server.appendBytesInFlight, 1000);
	second.write("b1 APPEND INBOX {1000}\r\n");
	const busy = await second.finish("b1");
	assert.deepEqual([busy.status, busy.detail], ["NO", "[LIMIT] Server busy, try again"]);
	const raw = mail({ body: "y".repeat(1000 - mail({ body: "" }).length) });
	assert.equal(Buffer.byteLength(raw, "latin1"), 1000);
	first.write(`${raw}\r\n`);
	assert.equal((await first.finish("a1")).status, "OK");
	assert.equal(w.server.appendBytesInFlight, 0);
	assert.equal((await append(second, "INBOX", raw)).status, "OK", "the budget is free again");
});

test("a client that goes away in the middle of an APPEND gives its share of the budget back", async (t) => {
	const w = await world(t, { maxMessageSize: 1000, appendBudget: 1500 });
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	client.write("a1 APPEND INBOX {1000}\r\n");
	await client.expect("+ Ready\r\n");
	client.write("partial");
	assert.equal(w.server.appendBytesInFlight, 1000);
	client.end();
	for (let waited = 0; w.server.appendBytesInFlight !== 0 && waited < 3000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(w.server.appendBytesInFlight, 0);
});

test("a message appended to the open folder reaches a second session in IDLE as EXISTS", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const first = await loggedIn(w, key);
	const second = await loggedIn(w, key);
	t.after(() => { first.end(); second.end(); });
	await second.cmd("SELECT INBOX");
	second.write("i1 IDLE\r\n");
	await second.expect("+ idling\r\n");
	await append(first, "INBOX", mail());
	await second.expect("* 1 EXISTS\r\n", 4000);
	second.write("DONE\r\n");
	await second.finish("i1");
});

test("imapflow can append, store, copy, move and expunge", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const flow = new ImapFlow({ host: "127.0.0.1", port: w.ports.tlsPort, secure: true, auth: { user: "me@example.test", pass: key.fullKey }, tls: { ca: certificate.cert, servername: "localhost" }, logger: false });
	flow.on("error", () => {});
	await flow.connect();
	t.after(async () => { await flow.logout().catch(() => {}); });
	const appended = await flow.append("INBOX", Buffer.from(mail({ subject: "Via imapflow" })), ["\\Seen"]);
	assert.equal(appended.uid, 1);
	const lock = await flow.getMailboxLock("INBOX");
	try {
		assert.equal(flow.mailbox.readOnly, false);
		await flow.messageFlagsAdd("1", ["\\Flagged"]);
		assert.equal(rowOf(w, "subject = 'Via imapflow'").starred, 1);
		const copied = await flow.messageCopy("1", "Archive");
		assert.equal(copied.uidMap.get(1), 1);
		const moved = await flow.messageMove("1", "Junk");
		assert.equal(moved.uidMap.get(1), 1);
		assert.equal(w.sqlite.prepare("SELECT status FROM messages WHERE subject = 'Via imapflow' ORDER BY status").all().map((row) => row.status).join(), "archived,spam");
	} finally {
		lock.release();
	}
	const trash = await flow.getMailboxLock("Junk");
	try {
		await flow.messageDelete("1");
	} finally {
		trash.release();
	}
	assert.equal(w.sqlite.prepare("SELECT status FROM messages WHERE subject = 'Via imapflow' AND status = 'trash'").all().length, 1, "deleting outside Trash moves to Trash");
});

// ---- CREATE, DELETE, RENAME, SUBSCRIBE ----

const foldersOf = (w, mailbox = "m1") => w.sqlite.prepare("SELECT id, name, user_id AS user FROM folders WHERE mailbox_id = ? ORDER BY name").all(mailbox);

test("CREATE makes a flat folder for the mailbox, LIST shows it under a placeholder parent, and the web folder list has it", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.equal((await client.cmd('CREATE "Clients/Acme"')).status, "OK");
	assert.deepEqual(foldersOf(w).map((row) => [row.name, row.user]), [["Clients/Acme", "u1"]]);
	const list = await client.cmd('LIST "" "Clients*"');
	assert.match(list.text, /\* LIST \(\\HasNoChildren\) "\/" "Clients\/Acme"\r\n\* LIST \(\\Noselect \\HasChildren\) "\/" "Clients"\r\n/);
	assert.equal((await client.cmd("SELECT Clients/Acme")).status, "OK");
	assert.equal((await client.cmd('CREATE "Clients/Acme"')).detail, "[ALREADYEXISTS] Mailbox already exists");
	assert.equal((await client.cmd("CREATE Clients")).status, "OK", "a placeholder name can become a folder");
	assert.equal((await client.cmd("CREATE inbox/Sub")).status, "OK");
	assert.deepEqual(foldersOf(w).map((row) => row.name), ["Clients", "Clients/Acme", "INBOX/Sub"]);
	assert.equal((await client.cmd("CREATE &AOQ-")).status, "OK", "modified UTF-7 names are decoded");
	assert.ok(foldersOf(w).some((row) => row.name === "\u00e4"));
	assert.equal((await client.cmd("CREATE Newparent/")).status, "OK", "a trailing delimiter only announces children");
	assert.equal(foldersOf(w).some((row) => row.name.startsWith("Newparent")), false);
});

test("CREATE refuses system names, reserved and malformed names, and too many folders", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	for (const name of ["INBOX", "inbox", "Sent", "Drafts", "Archive", "Junk", "Trash"]) assert.equal((await client.cmd(`CREATE ${name}`)).detail, "[ALREADYEXISTS] Mailbox already exists", name);
	for (const name of ["Shared", "Shared/x", "shared/x"]) assert.equal((await client.cmd(`CREATE ${name}`)).status, "NO", name);
	const bad = ['"a*"', '"a%"', '"a//b"', '"/a"', '"a/../b"', '"./a"', '" lead"', '"trail "', "&x", `"${"a".repeat(81)}"`, `"${Array.from({ length: 12 }, () => "a").join("/")}"`];
	for (const name of bad) assert.equal((await client.cmd(`CREATE ${name}`)).detail.split("]")[0], "[CANNOT", name);
	assert.equal((await client.cmd(`CREATE "${"a".repeat(80)}"`)).status, "OK", "80 characters is allowed");
	client.write("c1 CREATE {3+}\r\na\x01b\r\n");
	assert.equal((await client.finish("c1")).detail.split("]")[0], "[CANNOT", "control characters");
	assert.equal(foldersOf(w).length, 1);
	for (let index = 0; index < 499; index += 1) w.sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES (?, 'u1', 'm1', ?, 1)").run(`bulk${index}`, `bulk ${index}`);
	assert.equal((await client.cmd("CREATE one-too-many")).detail, "[LIMIT] Too many folders in this mailbox");
});

test("CREATE, DELETE and RENAME in a shared mailbox need full access there", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	addFolder(w, "sf", "Team stuff", "ms");
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	for (const command of ['CREATE "Shared/team@other.test/New"', 'DELETE "Shared/team@other.test/Team stuff"', 'RENAME "Shared/team@other.test/Team stuff" "Shared/team@other.test/Other"']) {
		assert.equal((await client.cmd(command)).detail, "[NOPERM] You may not change folders in this mailbox", command);
	}
	w.sqlite.prepare("UPDATE mailbox_access SET permission = 'send_as'").run();
	assert.equal((await client.cmd('CREATE "Shared/team@other.test/New"')).detail, "[NOPERM] You may not change folders in this mailbox", "send_as may write mail, not manage folders");
	w.sqlite.prepare("UPDATE mailbox_access SET permission = 'full_access'").run();
	assert.equal((await client.cmd('CREATE "Shared/team@other.test/New"')).status, "OK");
	assert.deepEqual(foldersOf(w, "ms").map((row) => [row.name, row.user]), [["New", "u2"], ["Team stuff", "u1"]]);
	assert.equal((await client.cmd('RENAME "Shared/team@other.test/New" "Shared/team@other.test/Newer"')).status, "OK");
	assert.equal((await client.cmd('RENAME "Shared/team@other.test/Newer" "Moved"')).detail.split("]")[0], "[CANNOT", "not into another mailbox");
	assert.equal((await client.cmd('DELETE "Shared/team@other.test/Newer"')).status, "OK");
	assert.equal((await client.cmd("CREATE Shared/nobody@x.test/F")).status, "NO");
	assert.equal((await client.cmd("CREATE Shared/team@other.test")).status, "NO");
});

test("DELETE removes a user folder and moves its messages to Trash; system folders and placeholders cannot be deleted", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	addFolder(w, "f1", "Work");
	addFolder(w, "f2", "Clients/Acme");
	w.addMessage({ id: "g1", folder_id: "f1" });
	w.addMessage({ id: "g2", folder_id: "f1", snoozed_until: 4_000_000_000 });
	w.addMessage({ id: "g3" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT Work");
	assert.equal((await client.cmd("DELETE Work")).status, "OK");
	assert.deepEqual(foldersOf(w).map((row) => row.name), ["Clients/Acme"]);
	assert.deepEqual([statusOf(w, "g1").status, statusOf(w, "g1").folder, statusOf(w, "g2").status], ["trash", null, "trash"]);
	assert.equal(statusOf(w, "g3").status, "received");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 3, "nothing was destroyed");
	for (const name of ["INBOX", "Sent", "Trash"]) assert.equal((await client.cmd(`DELETE ${name}`)).detail, "[CANNOT] System folders cannot be deleted", name);
	assert.equal((await client.cmd("DELETE Clients")).detail, "[NONEXISTENT] Mailbox does not exist", "a placeholder is not a folder");
	assert.equal((await client.cmd("DELETE Nothing")).detail, "[NONEXISTENT] Mailbox does not exist");
	assert.equal((await client.cmd("DELETE Shared")).status, "NO");
	assert.equal((await client.cmd("DELETE Clients/Acme")).status, "OK", "deleting a child leaves no placeholder");
	assert.doesNotMatch((await client.cmd('LIST "" "*"')).text, /Clients/);
	await client.cmd("SELECT Trash");
	assert.match((await client.cmd("SEARCH ALL")).text, /\* SEARCH 1 2/, "the messages are in Trash now");
});

test("RENAME keeps the folder's messages and UIDs, renames the folders below it too, and is all or nothing", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	addFolder(w, "f1", "Clients/Acme");
	addFolder(w, "f2", "Clients/Globex");
	addFolder(w, "f3", "Clients");
	addFolder(w, "f4", "Other");
	w.addMessage({ id: "g1", folder_id: "f1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const uid = (await client.cmd("SELECT Clients/Acme")).text.match(/UIDVALIDITY (\d+)/)[1];
	assert.equal((await client.cmd('RENAME "Clients/Acme" "Customers/Acme"')).status, "OK");
	assert.deepEqual(foldersOf(w).map((row) => row.name), ["Clients", "Clients/Globex", "Customers/Acme", "Other"]);
	const again = await client.cmd("SELECT Customers/Acme");
	assert.match(again.text, new RegExp(`UIDVALIDITY ${uid}\\]`), "same folder, same UIDs");
	assert.match(again.text, /\* 1 EXISTS/);
	assert.equal((await client.cmd("RENAME Clients Accounts")).status, "OK");
	assert.deepEqual(foldersOf(w).map((row) => row.name), ["Accounts", "Accounts/Globex", "Customers/Acme", "Other"], "the folder and the one below it");
	assert.equal((await client.cmd("RENAME Customers Kunden")).status, "OK", "a placeholder renames what is below it");
	assert.ok(foldersOf(w).some((row) => row.name === "Kunden/Acme"));
	assert.equal((await client.cmd("RENAME Other Accounts")).detail, "[ALREADYEXISTS] Mailbox already exists");
	assert.equal((await client.cmd("RENAME Other Sent")).detail, "[ALREADYEXISTS] Mailbox already exists");
	assert.equal((await client.cmd("RENAME Other Kunden")).status, "OK", "a placeholder name is free");
	addFolder(w, "f5", "Long/A");
	assert.equal((await client.cmd(`RENAME Long "${"x".repeat(79)}"`)).detail.split("]")[0], "[CANNOT", "a child whose new name is too long stops the whole rename");
	assert.ok(foldersOf(w).some((row) => row.name === "Long") === false && foldersOf(w).some((row) => row.name === "Long/A"), "nothing was renamed");
	for (const name of ["INBOX", "Sent", "Trash"]) assert.equal((await client.cmd(`RENAME ${name} Elsewhere`)).detail, "[CANNOT] System folders cannot be renamed", name);
	assert.equal((await client.cmd("RENAME Nothing Else")).detail, "[NONEXISTENT] Mailbox does not exist");
	assert.equal((await client.cmd("RENAME Kunden Sent")).detail, "[ALREADYEXISTS] Mailbox already exists");
	assert.equal((await client.cmd("RENAME Kunden Shared/x")).status, "NO");
});

test("SUBSCRIBE and UNSUBSCRIBE take one mailbox name; LSUB lists what LIST does", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	addFolder(w, "f1", "Work");
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.equal((await client.cmd("SUBSCRIBE Work")).status, "OK");
	assert.equal((await client.cmd("UNSUBSCRIBE Work")).status, "OK");
	assert.equal((await client.cmd("SUBSCRIBE")).status, "BAD");
	assert.equal((await client.cmd("SUBSCRIBE Work Extra")).status, "BAD");
	assert.equal((await client.cmd("SUBSCRIBE (a)")).status, "BAD");
	assert.match((await client.cmd('LSUB "" "*"')).text, /\* LSUB \(\\HasNoChildren \\Subscribed\) "\/" "Work"/);
});

test("imapflow can create, rename and delete a mailbox", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const flow = new ImapFlow({ host: "127.0.0.1", port: w.ports.tlsPort, secure: true, auth: { user: "me@example.test", pass: key.fullKey }, tls: { ca: certificate.cert, servername: "localhost" }, logger: false });
	flow.on("error", () => {});
	await flow.connect();
	t.after(async () => { await flow.logout().catch(() => {}); });
	assert.equal((await flow.mailboxCreate("Projects/Alpha")).created, true);
	assert.deepEqual(foldersOf(w).map((row) => row.name), ["Projects/Alpha"]);
	assert.equal((await flow.mailboxRename("Projects/Alpha", "Projects/Beta")).newPath, "Projects/Beta");
	assert.deepEqual(foldersOf(w).map((row) => row.name), ["Projects/Beta"]);
	await flow.mailboxDelete("Projects/Beta");
	assert.deepEqual(foldersOf(w), []);
});

test("a message another client moved keeps no \\Deleted flag, so an EXPUNGE in its new folder cannot remove what nobody flagged there", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1" });
	w.addMessage({ id: "g2" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	await client.cmd("STORE 1,2 +FLAGS (\\Deleted)");
	// The web app moves one of them to Trash and the other to a user folder while the flag is set.
	addFolder(w, "f1", "Keep");
	w.sqlite.prepare("UPDATE messages SET status = 'trash' WHERE id = 'g1'").run();
	w.sqlite.prepare("UPDATE messages SET folder_id = 'f1' WHERE id = 'g2'").run();
	await client.cmd("NOOP");
	assert.equal(flagsOf(w, "g1").deleted, 0);
	assert.equal(flagsOf(w, "g2").deleted, 0);
	await client.cmd("SELECT Trash");
	await client.cmd("EXPUNGE");
	await client.cmd("SELECT Keep");
	await client.cmd("EXPUNGE");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 2, "nothing was removed");
	assert.deepEqual([statusOf(w, "g1").status, statusOf(w, "g2").folder], ["trash", "f1"]);
});

test("a message that is first indexed in a folder after the flag was set elsewhere starts without \\Deleted", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "g1", status: "trash" });
	w.sqlite.prepare("INSERT INTO imap_message_flags (message_id, deleted, updated_at) VALUES ('g1', 1, 1)").run();
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.match((await client.cmd("SELECT Trash")).text, /\* 1 EXISTS/);
	assert.match((await client.cmd("FETCH 1 FLAGS")).text, /FLAGS \(\)/);
	await client.cmd("EXPUNGE");
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
});

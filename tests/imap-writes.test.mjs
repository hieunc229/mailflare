import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
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
			export { refusalKey } from "./src/lib/imap/fetch.ts";
			export { SearchEvaluator, parseSearchCriteria, decoderFor, MAX_KEYS } from "./src/lib/imap/search.ts";
			export { FolderView } from "./src/lib/imap/view.ts";
			export { getDb } from "./src/db/index.ts";
			export { messages } from "./src/db/schema/index.ts";
			export { eq } from "drizzle-orm";
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
const { ImapServer, SearchEvaluator, parseSearchCriteria, decoderFor, MAX_KEYS, FolderView, refusalKey, getDb, messages, eq, generateAppPassword, clearApiKeyVerificationCache, clearLoginAuditMemory, SqliteDatabase, applyMigrations, openFileBucket, openRateLimiter } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

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
// A header holding raw 8-bit octets (not an encoded word): it cannot be written as a quoted string.
const RAW_EIGHT_BIT = Buffer.concat([Buffer.from("From: a@x.test\r\nTo: me@example.test\r\nSubject: caf"), Buffer.from([0xe9]), Buffer.from("\r\nDate: Tue, 2 Jan 2024 10:00:00 +0000\r\n\r\nbody\r\n", "latin1")]);

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

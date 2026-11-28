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
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-drafts-"));
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
			export { deleteUnchanged } from "./src/lib/imap/transfer.ts";
			export { Gate } from "./src/lib/imap/gate.ts";
			export { appendGate, MAX_CONCURRENT_APPENDS } from "./src/lib/imap/append.ts";
			export { APPEND_MEMORY_FACTOR } from "./src/lib/imap/config.ts";
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
const { ImapServer, Gate, appendGate, MAX_CONCURRENT_APPENDS, APPEND_MEMORY_FACTOR, deleteUnchanged, rememberSubmission, clearSubmissionMemory, generateAppPassword, clearApiKeyVerificationCache, clearLoginAuditMemory, SqliteDatabase, applyMigrations, openFileBucket, openRateLimiter } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
// A throwaway certificate for 127.0.0.1 / localhost, made once for the file.
const keyPath = join(directory, "key.pem");
const certPath = join(directory, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
const certificate = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
const ca = certificate.cert;


async function world(t) {
	clearApiKeyVerificationCache();
	clearLoginAuditMemory();
	const database = new SqliteDatabase(":memory:");
	const bucket = openFileBucket(mkdtempSync(join(directory, "blobs-")));
	await applyMigrations(database, join(root, "drizzle/migrations"));
	seedWorld(database.db);
	// u1 (the login under test) is a full-access delegate of the shared mailbox ms, which u2 owns.
	database.db.exec("UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'ma1'");
	const helpers = makeHelpers(database.db, generateAppPassword);
	const env = { DB: database, BUCKET: bucket, MAILFLARE_RUNTIME: "node", DEVICE_LOGIN_RATE_LIMIT: openRateLimiter(10, 60) };
	const server = new ImapServer({ env, hostname: "mail.example.test", tlsPort: 0, starttlsPort: null, host: "127.0.0.1", certificate, failureDelayMs: 0, pollMs: 100 });
	const ports = await server.start();
	t.after(async () => {
		await server.stop();
		database.db.close();
		clearApiKeyVerificationCache();
	});
	const open = () => connectTlsClient(ports.tlsPort, ca);
	return { ...helpers, sqlite: database.db, env, bucket, open };
}

async function loggedIn(w, key, user) {
	const client = await w.open();
	await client.greeting();
	const result = await client.login(user, key.fullKey);
	assert.equal(result.status, "OK", result.text);
	return client;
}

const SECRET = "SECRETPLAN";
const TEAM = "Shared/team@other.test";

/** u2's private draft and the same kind of row u1 owns, and ordinary mail, all in the shared mailbox ms. */
function seed(w) {
	const draft = { mailbox_id: "ms", status: "draft", direction: "outbound", from_addr: "team@other.test", to_addr: "x@y.test" };
	w.addMessage({ id: "theirs", ...draft, user_id: "u2", private_draft: 1, subject: `${SECRET} draft`, text_body: `${SECRET} body`, read: 0 });
	w.addMessage({ id: "theirs-trash", mailbox_id: "ms", status: "trash", direction: "outbound", user_id: "u2", private_draft: 1, subject: `${SECRET} trashed`, text_body: `${SECRET} body`, read: 0 });
	w.addMessage({ id: "mine", ...draft, user_id: "u1", private_draft: 1, subject: "my own draft", text_body: "mine", read: 0 });
	w.addMessage({ id: "mail1", mailbox_id: "ms", user_id: "u2", subject: "ordinary mail", read: 0 });
	w.addMessage({ id: "sent1", mailbox_id: "ms", status: "sent", direction: "outbound", user_id: "u2", private_draft: 0, subject: "released draft", read: 1 });
}

const uidOf = (w, id) => Number(w.sqlite.prepare("SELECT uid FROM imap_uids WHERE message_id = ?").get(id)?.uid);
const row = (w, id) => w.sqlite.prepare("SELECT status, read, starred, folder_id, mailbox_id, private_draft, user_id FROM messages WHERE id = ?").get(id);
const count = (w, sql, ...params) => Number(w.sqlite.prepare(sql).get(...params).n);

async function selected(w, folder, user = "me@example.test", id = "k1", userId = "u1") {
	const key = await w.addKey({ id, userId });
	const client = await loggedIn(w, key, user);
	const select = await client.cmd(`SELECT ${TEAM}/${folder}`);
	assert.equal(select.status, "OK", select.text);
	return { client, select };
}

test("SELECT and EXAMINE count only the drafts the user may see", async (t) => {
	const w = await world(t);
	seed(w);
	const { client, select } = await selected(w, "Drafts");
	t.after(() => client.end());
	assert.match(select.text, /\* 1 EXISTS\r\n/, "my own draft only");
	assert.doesNotMatch(select.text, /\* 2 EXISTS/);
	const examine = await client.cmd(`EXAMINE ${TEAM}/Drafts`);
	assert.match(examine.text, /\* 1 EXISTS\r\n/);
	const trash = await client.cmd(`SELECT ${TEAM}/Trash`);
	assert.match(trash.text, /\* 0 EXISTS\r\n/, "a private draft the author moved to Trash stays private");
});

test("the author still sees and counts their own private draft", async (t) => {
	const w = await world(t);
	seed(w);
	const key = await w.addKey({ id: "k2", userId: "u2" });
	const client = await loggedIn(w, key, "two@other.test");
	t.after(() => client.end());
	const select = await client.cmd(`SELECT ${TEAM}/Drafts`);
	assert.match(select.text, /\* 1 EXISTS\r\n/, "u2's draft, not u1's");
	const fetched = await client.cmd("FETCH 1:* (UID ENVELOPE)");
	assert.match(fetched.text, new RegExp(SECRET));
	assert.doesNotMatch(fetched.text, /my own draft/);
});

test("STATUS and LIST-STATUS do not count another user's draft", async (t) => {
	const w = await world(t);
	seed(w);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key, "me@example.test");
	t.after(() => client.end());
	const status = await client.cmd(`STATUS ${TEAM}/Drafts (MESSAGES UNSEEN)`);
	assert.match(status.text, /MESSAGES 1 UNSEEN 1\)/);
	assert.match((await client.cmd(`STATUS ${TEAM}/Trash (MESSAGES UNSEEN)`)).text, /MESSAGES 0 UNSEEN 0\)/);
	const list = await client.cmd(`LIST "" "${TEAM}/%" RETURN (STATUS (MESSAGES UNSEEN))`);
	assert.match(list.text, /STATUS "?Shared\/team@other\.test\/Drafts"? \(MESSAGES 1 UNSEEN 1\)/);
	assert.match(list.text, /STATUS "?Shared\/team@other\.test\/Trash"? \(MESSAGES 0 UNSEEN 0\)/);
});

test("FETCH never returns, sizes or reads another user's draft, by number or by UID", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const hidden = uidOf(w, "theirs");
	assert.ok(hidden >= 1);
	const all = await client.cmd("FETCH 1:* (UID FLAGS ENVELOPE RFC822.SIZE BODY.PEEK[])");
	assert.doesNotMatch(all.text, new RegExp(SECRET));
	assert.equal((all.text.match(/^\* \d+ FETCH/gm) ?? []).length, 1);
	for (const command of [`UID FETCH ${hidden} (UID FLAGS)`, `UID FETCH ${hidden}:* (BODY.PEEK[])`, `UID FETCH 1:${hidden + 5} (RFC822.SIZE)`]) {
		const answer = await client.cmd(command);
		assert.doesNotMatch(answer.text, new RegExp(`UID ${hidden}\\b`), command);
		assert.doesNotMatch(answer.text, new RegExp(SECRET), command);
	}
	assert.doesNotMatch((await client.cmd("FETCH 2 (UID)")).text, /^\* \d+ FETCH/m, "no second message in the view");
	assert.equal(row(w, "theirs").read, 0, "nothing was marked read by peeking");
});

test("SEARCH never matches another user's draft", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const hidden = uidOf(w, "theirs");
	const mine = uidOf(w, "mine");
	for (const query of ["SEARCH ALL", `SEARCH SUBJECT ${SECRET}`, `SEARCH TEXT ${SECRET}`, `SEARCH BODY ${SECRET}`, "SEARCH UNSEEN", `SEARCH UID ${hidden}`, "SEARCH NOT SEEN", "SEARCH LARGER 1", "SEARCH HEADER Subject secret", "SEARCH DRAFT", "SEARCH MODSEQ 1"]) {
		const answer = await client.cmd(query);
		assert.equal(answer.status, "OK", query);
		assert.doesNotMatch(answer.text, /\* SEARCH[^\r\n]*\b2\b/, `${query} found a second message`);
	}
	assert.match((await client.cmd("SEARCH ALL")).text, /\* SEARCH 1\r\n/);
	assert.match((await client.cmd(`UID SEARCH UID ${hidden}:*`)).text, new RegExp(`\\* SEARCH ${mine}\\r\\n|\\* SEARCH\\r\\n`));
	assert.doesNotMatch((await client.cmd(`UID SEARCH ALL`)).text, new RegExp(`\\b${hidden}\\b`));
	const esearch = await client.cmd(`UID SEARCH RETURN (ALL COUNT MAX) SUBJECT ${SECRET}`);
	assert.match(esearch.text, /COUNT 0/);
});

test("sequence numbers and UID sets are the user's own: a hidden UID cannot be named", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const hidden = uidOf(w, "theirs");
	const mine = uidOf(w, "mine");
	const all = await client.cmd("UID FETCH 1:* (UID)");
	assert.deepEqual([...all.text.matchAll(/\* (\d+) FETCH \(UID (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]), [[1, mine]]);
	assert.doesNotMatch((await client.cmd(`UID FETCH ${hidden} (UID)`)).text, /^\* \d+ FETCH/m);
});

test("STORE, UID STORE and STORE UNCHANGEDSINCE leave another user's draft alone", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const hidden = uidOf(w, "theirs");
	await client.cmd("STORE 1:* +FLAGS (\\Seen \\Flagged \\Deleted Orders)");
	for (const command of [`UID STORE ${hidden} +FLAGS (\\Seen \\Flagged \\Deleted)`, `UID STORE ${hidden}:* FLAGS (\\Seen)`, `UID STORE ${hidden} (UNCHANGEDSINCE 99999) +FLAGS (\\Seen)`]) {
		const answer = await client.cmd(command);
		assert.doesNotMatch(answer.text, new RegExp(`UID ${hidden}\\b`), command);
	}
	assert.deepEqual({ ...w.sqlite.prepare("SELECT read, starred FROM messages WHERE id = 'theirs'").get() }, { read: 0, starred: 0 });
	assert.equal(w.sqlite.prepare("SELECT 1 FROM imap_message_flags WHERE message_id = 'theirs'").get(), undefined, "no IMAP flag row was written");
	assert.equal(row(w, "mine").read, 1, "the user's own draft was changed");
});

test("COPY and UID COPY never duplicate another user's draft", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const hidden = uidOf(w, "theirs");
	const before = count(w, "SELECT count(*) AS n FROM messages");
	for (const command of [`UID COPY ${hidden} ${TEAM}/Archive`, `UID COPY 1:${hidden + 9} ${TEAM}/Archive`, `UID COPY ${hidden} INBOX`]) {
		const answer = await client.cmd(command);
		assert.doesNotMatch(answer.text, new RegExp(`COPYUID \\d+ [^ ]*\\b${hidden}\\b`), command);
	}
	assert.equal(count(w, "SELECT count(*) AS n FROM messages WHERE subject LIKE ?", `${SECRET}%`), 2, "the two private rows are the only ones with that subject: nothing was copied");
	assert.equal(count(w, "SELECT count(*) AS n FROM messages"), before + 1 /* mine, copied once to Archive */, "only the user's own draft was copied");
});

test("copying a message into Drafts makes a private draft of the copier's", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "INBOX");
	t.after(() => client.end());
	const answer = await client.cmd(`UID COPY ${uidOf(w, "mail1")} ${TEAM}/Drafts`);
	assert.equal(answer.status, "OK", answer.text);
	const copy = w.sqlite.prepare("SELECT user_id, private_draft, status FROM messages WHERE status = 'draft' AND subject = 'ordinary mail'").get();
	assert.deepEqual({ ...copy }, { user_id: "u1", private_draft: 1, status: "draft" });
});

test("MOVE and UID MOVE never move another user's draft", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const hidden = uidOf(w, "theirs");
	for (const command of [`UID MOVE ${hidden} ${TEAM}/Archive`, `UID MOVE 1:${hidden + 9} ${TEAM}/Trash`, `UID MOVE ${hidden} INBOX`]) await client.cmd(command);
	assert.deepEqual({ ...row(w, "theirs") }, { status: "draft", read: 0, starred: 0, folder_id: null, mailbox_id: "ms", private_draft: 1, user_id: "u2" });
	assert.equal(row(w, "mine").status, "trash", "the user's own draft did move");
});

test("MOVE of a message into Drafts makes it private and hides it from the other readers", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "INBOX");
	t.after(() => client.end());
	const answer = await client.cmd(`UID MOVE ${uidOf(w, "mail1")} ${TEAM}/Drafts`);
	assert.equal(answer.status, "OK", answer.text);
	assert.equal(row(w, "mail1").private_draft, 1);
	assert.equal(count(w, "SELECT count(*) AS n FROM jmap_changes WHERE object_id = 'mail1' AND change = 'hidden'"), 1, "readers of the mailbox are told, as JMAP does");
});

test("EXPUNGE, UID EXPUNGE and CLOSE never remove another user's flagged draft", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const hidden = uidOf(w, "theirs");
	// Flagged by its author after the folder was indexed (indexing a message clears a \\Deleted flag from an earlier folder).
	w.sqlite.prepare("INSERT INTO imap_message_flags (message_id, deleted, updated_at) VALUES ('theirs', 1, 1)").run();
	await client.cmd("STORE 1 +FLAGS (\\Deleted)");
	assert.doesNotMatch((await client.cmd(`UID EXPUNGE ${hidden}`)).text, /EXPUNGE\r\n/, "the hidden UID is outside the view");
	assert.ok(w.sqlite.prepare("SELECT 1 FROM messages WHERE id = 'theirs'").get(), "UID EXPUNGE left it");
	assert.ok(w.sqlite.prepare("SELECT 1 FROM messages WHERE id = 'mine'").get(), "and did not touch the user's own flagged draft");
	await client.cmd("EXPUNGE");
	assert.ok(w.sqlite.prepare("SELECT 1 FROM messages WHERE id = 'theirs'").get(), "EXPUNGE left it");
	assert.equal(w.sqlite.prepare("SELECT 1 FROM messages WHERE id = 'mine'").get(), undefined, "the user's own draft was removed for good");
	await client.cmd(`SELECT ${TEAM}/Drafts`);
	await client.cmd("CLOSE");
	assert.ok(w.sqlite.prepare("SELECT 1 FROM messages WHERE id = 'theirs'").get(), "CLOSE left it");
	assert.equal(w.sqlite.prepare("SELECT deleted FROM imap_message_flags WHERE message_id = 'theirs'").get().deleted, 1, "its flag is untouched");
});

async function append(client, folder, raw) {
	const tag = `p${++client.counter}`;
	client.write(`${tag} APPEND ${folder} {${Buffer.byteLength(raw, "latin1")}}\r\n`);
	await client.expect("+ Ready\r\n", 4000);
	client.write(`${raw}\r\n`);
	return client.finish(tag, 8000);
}

test("APPEND to Drafts makes a draft only its author sees", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	const raw = ["From: team@other.test", "To: z@y.test", "Subject: appended by the delegate", "Date: Mon, 1 Jan 2024 10:00:00 +0000", "Message-ID: <app1@x.test>", "", "hello", ""].join("\r\n");
	const appended = await append(client, `${TEAM}/Drafts`, raw);
	assert.equal(appended.status, "OK", appended.text);
	const stored = w.sqlite.prepare("SELECT user_id, private_draft, status FROM messages WHERE subject = 'appended by the delegate'").get();
	assert.deepEqual({ ...stored }, { user_id: "u1", private_draft: 1, status: "draft" });
	assert.match((await client.cmd("NOOP")).text + (await client.cmd(`STATUS ${TEAM}/Drafts (MESSAGES)`)).text, /MESSAGES 2/, "the author sees both of their drafts");
	const key = await w.addKey({ id: "k2", userId: "u2" });
	const owner = await loggedIn(w, key, "two@other.test");
	t.after(() => owner.end());
	const select = await owner.cmd(`SELECT ${TEAM}/Drafts`);
	assert.match(select.text, /\* 1 EXISTS\r\n/, "the owner sees only their own draft");
	assert.doesNotMatch((await owner.cmd("FETCH 1:* (ENVELOPE)")).text, /appended by the delegate|my own draft/);
	assert.match((await owner.cmd(`STATUS ${TEAM}/Drafts (MESSAGES)`)).text, /MESSAGES 1\)/);
});

test("a draft saved while another user has the folder open does not reach that user", async (t) => {
	const w = await world(t);
	seed(w);
	const { client } = await selected(w, "Drafts");
	t.after(() => client.end());
	w.addMessage({ id: "late", mailbox_id: "ms", status: "draft", direction: "outbound", user_id: "u2", private_draft: 1, subject: `${SECRET} late`, text_body: SECRET });
	await new Promise((resolve) => setTimeout(resolve, 300));
	const noop = await client.cmd("NOOP");
	assert.doesNotMatch(noop.text, /EXISTS|FETCH|EXPUNGE/, noop.text);
	assert.doesNotMatch(noop.text, new RegExp(SECRET));
});

test("CONDSTORE and QRESYNC never report another user's draft", async (t) => {
	const w = await world(t);
	seed(w);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key, "me@example.test");
	t.after(() => client.end());
	assert.equal((await client.cmd("ENABLE QRESYNC")).status, "OK");
	const hidden = uidOf(w, "theirs") || 1;
	await client.cmd(`SELECT ${TEAM}/Drafts`);
	await client.cmd("CLOSE");
	const resync = await client.cmd(`SELECT ${TEAM}/Drafts (QRESYNC (${Number(w.sqlite.prepare("SELECT uidvalidity FROM imap_folder_state WHERE id = 'ms:drafts'").get().uidvalidity)} 1))`);
	assert.doesNotMatch(resync.text, new RegExp(`UID ${uidOf(w, "theirs")}\\b`));
	assert.match(resync.text, /\* 1 EXISTS/);
	const changed = await client.cmd("FETCH 1:* (UID FLAGS) (CHANGEDSINCE 1)");
	assert.doesNotMatch(changed.text, new RegExp(`UID ${uidOf(w, "theirs")}\\b`));
	const vanished = await client.cmd("UID FETCH 1:* (UID) (CHANGEDSINCE 1 VANISHED)");
	assert.doesNotMatch(vanished.text, new RegExp(`UID ${uidOf(w, "theirs")}\\b`));
	assert.doesNotMatch(vanished.text, new RegExp(`VANISHED[^\\r\\n]*\\b${uidOf(w, "theirs")}\\b`));
	void hidden;
});

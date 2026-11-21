import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createServer as createNetServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ImapFlow } from "imapflow";
import { connectPlainClient, connectTlsClient, upgradeToTls } from "./helpers/imap-client.mjs";
import { makeHelpers, seedWorld } from "./helpers/imap-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-protocol-"));
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

test("a real TLS connection greets, advertises TLS-only login and the read-only command set", async (t) => {
	const w = await world(t);
	const client = await w.open();
	t.after(() => client.end());
	assert.match(await client.greeting(), /^\* OK \[CAPABILITY IMAP4rev1 SASL-IR LITERAL\+ ID ENABLE AUTH=PLAIN\] mail\.example\.test/);
	const capability = await client.cmd("CAPABILITY");
	assert.match(capability.text, /\* CAPABILITY IMAP4rev1 SASL-IR LITERAL\+ ID ENABLE AUTH=PLAIN\r\n/);
	assert.doesNotMatch(capability.text, /STARTTLS|LOGINDISABLED/, "already encrypted");
	assert.equal((await client.cmd("NOOP")).status, "OK");
	assert.equal((await client.cmd("SELECT INBOX")).status, "BAD", "not logged in yet");
	const logout = await client.cmd("LOGOUT");
	assert.match(logout.text, /\* BYE/);
	await client.closedPromise;
});

test("LOGIN and AUTHENTICATE PLAIN with an app password; wrong, account and wrong-scope passwords all fail alike", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const jmapOnly = await w.addKey({ id: "k2", scopes: ["jmap"] });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	const failures = [
		await client.login("me@example.test", "wrong-password-value"),
		await client.login("nobody@example.test", key.fullKey),
		await client.login("me@example.test", jmapOnly.fullKey),
		await client.login("two@other.test", key.fullKey),
	];
	for (const failure of failures) assert.deepEqual([failure.status, failure.detail], ["NO", "[AUTHENTICATIONFAILED] Authentication failed"]);
	const login = await client.login("me@example.test", key.fullKey);
	assert.match(login.detail, /^\[CAPABILITY IMAP4rev1 .*IDLE.*\] Logged in$/);
	assert.equal((await client.login("me@example.test", key.fullKey)).status, "BAD", "already logged in");

	const second = await w.open();
	t.after(() => second.end());
	await second.greeting();
	const plain = (user, secret) => Buffer.from(`\0${user}\0${secret}`).toString("base64");
	assert.equal((await second.cmd(`AUTHENTICATE PLAIN ${plain("me@example.test", key.fullKey)}`)).status, "OK", "SASL-IR");
	const third = await w.open();
	t.after(() => third.end());
	await third.greeting();
	third.write("x AUTHENTICATE PLAIN\r\n");
	await third.expect("+ \r\n");
	third.write(`${plain("me@example.test", key.fullKey)}\r\n`);
	assert.equal((await third.finish("x")).status, "OK", "continuation");
	const fourth = await w.open();
	t.after(() => fourth.end());
	await fourth.greeting();
	assert.equal((await fourth.cmd(`AUTHENTICATE PLAIN ${plain("me@example.test", "nope-nope-nope-nope")}`)).detail, "[AUTHENTICATIONFAILED] Authentication failed");
	assert.equal((await fourth.cmd("AUTHENTICATE XOAUTH2 abc")).detail, "[CANNOT] Mechanism not supported");
	assert.equal((await fourth.cmd("AUTHENTICATE PLAIN !!!notbase64")).detail, "[AUTHENTICATIONFAILED] Authentication failed");
});

test("an AUTHENTICATE reply that ends in a literal size is answered with a continuation, then refused", async (t) => {
	const w = await world(t);
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	client.write("a1 AUTHENTICATE PLAIN\r\n");
	await client.expect("+ \r\n");
	client.write("AAAA{3}\r\n");
	await client.expect("+ Ready\r\n", 2000);
	client.write("abc\r\n");
	const result = await client.finish("a1");
	assert.deepEqual([result.status, result.detail], ["NO", "[AUTHENTICATIONFAILED] Authentication failed"]);
	assert.equal((await client.cmd("NOOP")).status, "OK", "the connection is still in step");
});

test("every failed login writes one log line: address bucket, reason code, a short printable user name, never the password", async (t) => {
	const warnings = [];
	t.mock.method(console, "warn", (...args) => { warnings.push(args.map(String).join(" ")); });
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const lines = () => warnings.filter((line) => line.startsWith("IMAP login failed"));
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();

	await client.login("me@example.test", "wrong-password-value-12345");
	assert.deepEqual(lines(), ['IMAP login failed ip=127.0.0.1 reason=bad_secret user="me@example.test"']);
	await client.login("nobody@example.test", key.fullKey);
	assert.equal(lines()[1], 'IMAP login failed ip=127.0.0.1 reason=no_mailbox user="nobody@example.test"');
	await client.cmd("AUTHENTICATE PLAIN !!!notbase64");
	assert.equal(lines()[2], 'IMAP login failed ip=127.0.0.1 reason=malformed user=""');
	const long = `${"a".repeat(70)}\x01\x7f\xe9"q\\`;
	client.write(`l1 LOGIN {${long.length}+}\r\n${long} "wrong-password-value-67890"\r\n`);
	await client.finish("l1");
	assert.equal(lines()[3], `IMAP login failed ip=127.0.0.1 reason=bad_secret user="${"a".repeat(64)}"`, "cut to 64 characters");
	const second = await w.open();
	t.after(() => second.end());
	await second.greeting();
	second.write(`l2 LOGIN {8+}\r\nx\x01y\x7f\xe9"q\\ "wrong-password-value-67890"\r\n`);
	await second.finish("l2");
	assert.equal(lines()[4], 'IMAP login failed ip=127.0.0.1 reason=bad_secret user="x?y??\\"q\\\\"', "control and 8-bit characters become ?, quote and backslash are escaped");
	for (const line of warnings) assert.ok(!line.includes("wrong-password-value") && !line.includes(key.fullKey), line);
	assert.equal(lines().length, 5, "one line per failure");
	assert.equal((await second.login("me@example.test", key.fullKey)).status, "OK");
	assert.equal(lines().length, 5, "a successful login writes none");
});

test("the app password's address is the account: a delegate can log in as the shared mailbox", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("t1", RAW_ALTERNATIVE, { mailbox_id: "ms", to_addr: "team@other.test" });
	const client = await loggedIn(w, key, "team@other.test");
	t.after(() => client.end());
	const select = await client.cmd("SELECT INBOX");
	assert.match(select.text, /\* 1 EXISTS/);
});

test("LIST: system folders with special-use, user folders, namespaces; names are quoted and encoded", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f1', 'u1', 'm1', ?, 1), ('f2', 'u1', 'm1', 'Say \"hi\" \\ back', 1), ('f3', 'u1', 'm1', 'Shared/sneaky', 1)").run("Clients/Café &");
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const list = (await client.cmd('LIST "" "*"')).text;
	assert.match(list, /\* LIST \(\\HasNoChildren\) "\/" "INBOX"\r\n/);
	assert.match(list, /\* LIST \(\\Sent \\HasNoChildren\) "\/" "Sent"\r\n/);
	assert.match(list, /\* LIST \(\\Trash \\HasNoChildren\) "\/" "Trash"\r\n/);
	assert.match(list, /\* LIST \(\\Noselect \\HasChildren\) "\/" "Clients"\r\n/);
	assert.match(list, /\* LIST \(\\HasNoChildren\) "\/" "Clients\/Caf&AOk- &-"\r\n/, "modified UTF-7");
	assert.match(list, /\* LIST \(\\HasNoChildren\) "\/" "Say \\"hi\\" \\\\ back"\r\n/, "quote and backslash escaped");
	assert.match(list, /"Shared \(folder\)\/sneaky"/, "a user folder cannot pose as the shared namespace");
	assert.match(list, /\* LIST \(\\Noselect \\HasChildren\) "\/" "Shared"\r\n/);
	assert.match(list, /\* LIST \(\\Noselect \\HasChildren\) "\/" "Shared\/team@other\.test"\r\n/);
	assert.match(list, /"Shared\/team@other\.test\/INBOX"/);
	assert.match(list, /\* LIST \(\\Sent \\HasNoChildren\) "\/" "Shared\/team@other\.test\/Sent"/);
	assert.doesNotMatch(list, /two@other\.test/, "mailboxes nobody shared with this user are not listed");
	assert.match(list, /"Shared\/second@example\.test\/INBOX"/, "the user's other mailbox is a shared-namespace folder too");
	assert.equal((await client.cmd('LIST "" ""')).text.split("\r\n")[0], '* LIST (\\Noselect) "/" ""');
	assert.match((await client.cmd('LIST "" "inbox"')).text, /"INBOX"/, "INBOX is case-insensitive");
	assert.doesNotMatch((await client.cmd('LIST "" "Shared/%"')).text, /INBOX/, "% stops at the delimiter");
	assert.match((await client.cmd('LIST (SPECIAL-USE) "" "*"')).text, /Drafts/);
	assert.doesNotMatch((await client.cmd('LIST (SPECIAL-USE) "" "*"')).text, /"INBOX"/);
	assert.equal((await client.cmd(`LIST "" "${"*".repeat(9)}"`)).status, "BAD", "too many wildcards");
	assert.equal((await client.cmd(`LIST "" "${"a".repeat(300)}"`)).status, "BAD", "pattern too long");
	assert.equal((await client.cmd('LSUB "" "Sent"')).text.split("\r\n")[0], '* LSUB (\\Sent \\HasNoChildren \\Subscribed) "/" "Sent"');
	assert.match((await client.cmd('NAMESPACE')).text, /\* NAMESPACE \(\(\"\" \"\/\"\)\) NIL \(\(\"Shared\/\" \"\/\"\)\)/);
});

test("LIST takes at most 16 patterns in one command", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const patterns = (count) => `(${Array.from({ length: count }, (_, index) => `"Folder${index}"`).join(" ")})`;
	assert.equal((await client.cmd(`LIST "" ${patterns(16)}`)).status, "OK");
	const over = await client.cmd(`LIST "" ${patterns(17)}`);
	assert.deepEqual([over.status, over.detail], ["BAD", "Too many LIST patterns"]);
	assert.equal((await client.cmd(`LIST "" ${patterns(400)}`)).status, "BAD");
});

test("LIST-STATUS answers STATUS for the folders it lists", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	await w.addRaw("g2", RAW_ALTERNATIVE, { read: 1 });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	const result = (await client.cmd('LIST "" "INBOX" RETURN (CHILDREN STATUS (MESSAGES UNSEEN UIDNEXT))')).text;
	assert.match(result, /\* LIST \(\\HasNoChildren\) "\/" "INBOX"\r\n\* STATUS "INBOX" \(MESSAGES 2 UNSEEN 1 UIDNEXT 3\)\r\n/);
});

test("STATUS and SELECT report the folder; EXAMINE is read-only, SELECT of an own mailbox is read-write; unknown folders do not exist", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	await w.addRaw("g2", RAW_EIGHT_BIT, { read: 1 });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.match((await client.cmd("STATUS INBOX (MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN)")).text, /\* STATUS "INBOX" \(MESSAGES 2 RECENT 0 UIDNEXT 3 UIDVALIDITY \d+ UNSEEN 1\)/);
	assert.equal((await client.cmd("STATUS INBOX (SIZE)")).status, "BAD");
	assert.equal((await client.cmd("STATUS Nope (MESSAGES)")).detail, "[NONEXISTENT] Mailbox does not exist");
	const select = await client.cmd("SELECT INBOX");
	assert.match(select.text, /\* FLAGS \(\\Answered \\Flagged \\Deleted \\Seen \\Draft \$Forwarded\)\r\n\* 2 EXISTS\r\n\* 0 RECENT\r\n\* OK \[UIDVALIDITY \d+\] UIDs valid\r\n\* OK \[UIDNEXT 3\] Predicted next UID\r\n\* OK \[PERMANENTFLAGS \(\\Answered \\Flagged \\Deleted \\Seen \$Forwarded \\\*\)\] Limited\r\n/);
	assert.equal(select.detail, "[READ-WRITE] SELECT completed");
	assert.equal((await client.cmd("EXAMINE Sent")).detail, "[READ-ONLY] EXAMINE completed");
	assert.equal((await client.cmd("SELECT Clients/None")).status, "NO");
	assert.equal((await client.cmd("FETCH 1 FLAGS")).status, "BAD", "a failed SELECT leaves nothing selected");
	assert.equal((await client.cmd("SELECT Shared/two@other.test/INBOX")).detail, "[NONEXISTENT] Mailbox does not exist", "another user's mailbox cannot be reached by name");
	assert.equal((await client.cmd("SELECT Shared")).status, "NO", "a placeholder cannot be selected");
	assert.equal((await client.cmd("SELECT Shared/team@other.test")).status, "NO");
	assert.equal((await client.cmd("SELECT inbox/..")).status, "NO");
	assert.equal((await client.cmd("SELECT INBOX (CONDSTORE)")).status, "BAD", "no select parameters are offered");
});

test("FETCH: flags, internal date, size, envelope, bodystructure, sections and partials", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE, { starred: 1 });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const fast = (await client.cmd("FETCH 1 (FLAGS INTERNALDATE RFC822.SIZE UID)")).text;
	assert.match(fast, /^\* 1 FETCH \(FLAGS \(\\Flagged\) INTERNALDATE "\d\d-[A-Z][a-z]{2}-\d{4} \d\d:\d\d:\d\d \+0000" RFC822\.SIZE (\d+) UID 1\)\r\n/);
	assert.equal(Number(fast.match(/RFC822\.SIZE (\d+)/)[1]), Buffer.byteLength(RAW_ALTERNATIVE));
	assert.match((await client.cmd("FETCH 1 ENVELOPE")).text, /^\* 1 FETCH \(ENVELOPE \("Mon, 1 Jan 2024 10:00:00 \+0000" "Hello there" \(\("=\?UTF-8\?B\?w4RuZHJpcw==\?=" NIL "a" "x\.test"\)\)/);
	assert.match((await client.cmd("FETCH 1 BODYSTRUCTURE")).text, /BODYSTRUCTURE \(\("text" "plain" \("charset" "utf-8"\) NIL NIL "7bit" 10 0 NIL NIL NIL NIL\)\("text" "html" NIL NIL NIL "7bit" 16 0 NIL NIL NIL NIL\) "alternative" \("boundary" "A"\) NIL NIL NIL\)/);
	assert.match((await client.cmd("FETCH 1 BODY")).text, /BODY \(\("text" "plain" \("charset" "utf-8"\) NIL NIL "7bit" 10 0\)\("text" "html" NIL NIL NIL "7bit" 16 0\) "alternative"\)\)/, "BODY has no extension data");
	const whole = (await client.cmd("UID FETCH 1 BODY.PEEK[]")).text;
	const literal = `{${Buffer.byteLength(RAW_ALTERNATIVE)}}\r\n${RAW_ALTERNATIVE}`;
	assert.ok(whole.includes(`* 1 FETCH (UID 1 BODY[] ${literal})\r\n`), "the whole message, byte for byte");
	assert.match((await client.cmd("FETCH 1 BODY.PEEK[1]")).text, /BODY\[1\] \{10\}\r\nplain body\)/);
	assert.match((await client.cmd("FETCH 1 BODY.PEEK[2.MIME]")).text, /BODY\[2\.MIME\] \{\d+\}\r\nContent-Type: text\/html\r\n\r\n\)/);
	assert.match((await client.cmd("FETCH 1 BODY.PEEK[1]<2.5>")).text, /BODY\[1\]<2> \{5\}\r\nain b\)/);
	assert.match((await client.cmd("FETCH 1 BODY.PEEK[HEADER.FIELDS (Subject \"Message-ID\")]")).text, /BODY\[HEADER\.FIELDS \(Subject Message-ID\)\] \{\d+\}\r\nSubject: Hello there\r\nMessage-ID: <m1@x\.test>\r\n\r\n\)/);
	assert.match((await client.cmd("FETCH 1 BODY.PEEK[9]")).text, /BODY\[9\] NIL\)/, "a part that does not exist");
	assert.match((await client.cmd("FETCH 1 RFC822.HEADER")).text, /RFC822\.HEADER \{\d+\}\r\nFrom: /);
	assert.equal((await client.cmd("FETCH 1:* (FLAGS)")).text.match(/\* \d+ FETCH/g).length, 1);
	assert.equal((await client.cmd("FETCH 5 (FLAGS)")).text, "a" + (client.counter) + " OK FETCH completed\r\n", "a number past the end selects nothing");
	assert.equal((await client.cmd("FETCH 1 (X-BOGUS)")).status, "BAD");
	assert.equal((await client.cmd("FETCH 1 BODY[0]")).status, "BAD");
	assert.equal((await client.cmd("FETCH 1 BODY[HEADER.FIELDS ()]")).status, "BAD");
	assert.equal((await client.cmd("FETCH abc FLAGS")).status, "BAD");
	assert.equal((await client.cmd("FETCH 1 BODY[]<0.0>")).status, "BAD");
	assert.equal((await client.cmd("FETCH 1 MODSEQ")).status, "BAD", "CONDSTORE is not offered");
});

test("FETCH: at most 64 items, repeated items are sent once, and a literal goes to the socket as its own buffer", async (t) => {
	const w = await world(t, { maxFetchBytes: 4 * 1024 * 1024 });
	const key = await w.addKey({ id: "k1" });
	const big = Buffer.concat([Buffer.from("From: a@x.test\r\nSubject: big\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\n\r\n"), Buffer.alloc(300 * 1024, "x")]);
	await w.addRaw("big", big);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");

	const many = (count, unit) => Array(count).fill(unit).join(" ");
	const over = await client.cmd(`FETCH 1 (${many(400, "BODY.PEEK[]")})`);
	assert.deepEqual([over.status, over.detail], ["BAD", "Too many FETCH items"]);
	assert.equal(over.text.includes("BODY[]"), false, "nothing was sent for it");
	assert.equal((await client.cmd(`FETCH 1 (${many(65, "FLAGS")})`)).status, "BAD");
	assert.equal((await client.cmd(`FETCH 1 (${many(64, "FLAGS")})`)).status, "OK");

	const once = (await client.cmd("FETCH 1 (FLAGS UID FLAGS BODY.PEEK[1] BODY.PEEK[1] UID FLAGS)")).text;
	assert.equal(once.match(/FLAGS/g).length, 1);
	assert.equal(once.match(/UID/g).length, 1);
	assert.equal(once.match(/BODY\[1\]/g).length, 1);
	assert.equal((await client.cmd("FETCH 1 (FAST FLAGS INTERNALDATE)")).text.match(/INTERNALDATE/g).length, 1, "a macro is expanded before repeats are dropped");
	assert.equal((await client.cmd("UID FETCH 1 (UID FLAGS)")).lines[0].match(/UID/g).length, 1);

	// The literal is written as one buffer of its own length, not copied into a larger response string.
	const connection = [...w.server.connections][0];
	const writes = [];
	const write = connection.socket.write.bind(connection.socket);
	connection.socket.write = (chunk, ...rest) => { writes.push(chunk.length); return write(chunk, ...rest); };
	const whole = await client.cmd("FETCH 1 BODY.PEEK[]", { ms: 20000 });
	assert.equal(whole.status, "OK");
	assert.ok(whole.text.includes(`{${big.length}}\r\n`));
	assert.ok(writes.includes(big.length), `writes: ${writes.join(", ")}`);
	assert.ok(Math.max(...writes) === big.length, "no write is larger than the literal");
});

test("FETCH stops with NO [LIMIT] when the sections of one command add up to more than the byte budget", async (t) => {
	const w = await world(t, { maxFetchBytes: 900 });
	const key = await w.addKey({ id: "k1" });
	for (const id of ["g1", "g2", "g3"]) await w.addRaw(id, RAW_ALTERNATIVE);
	const size = Buffer.byteLength(RAW_ALTERNATIVE);
	assert.ok(size * 2 <= 900 && size * 3 > 900, `the fixture is ${size} bytes`);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const result = await client.cmd("FETCH 1:3 BODY.PEEK[]");
	assert.deepEqual([result.status, result.detail], ["NO", "[LIMIT] The fetch is too large; fetch fewer messages at once"]);
	assert.equal(result.text.match(/\* \d FETCH/g).length, 2, "the messages before the budget ran out were sent whole");
	assert.ok(Buffer.byteLength(result.text, "latin1") < 900 + 400, `${Buffer.byteLength(result.text, "latin1")} bytes were sent`);
	assert.equal((await client.cmd("FETCH 1:3 (FLAGS ENVELOPE BODY.PEEK[HEADER.FIELDS (Subject)])")).status, "OK", "headers are charged by their own size");
	assert.equal((await client.cmd("FETCH 1:2 BODY.PEEK[]")).status, "OK");
});

test("FETCH of a message with raw 8-bit header octets sends them as a literal, never as a quoted string", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_EIGHT_BIT);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const envelope = (await client.cmd("FETCH 1 ENVELOPE")).text;
	assert.ok(envelope.includes('ENVELOPE ("Tue, 2 Jan 2024 10:00:00 +0000" {4}\r\ncaf\xe9 '), JSON.stringify(envelope));
});

test("FETCH of a message with no stored raw bytes serves the synthesized message; UID FETCH ranges and *", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	w.addMessage({ id: "s1", direction: "outbound", status: "sent", from_addr: "me@example.test", to_addr: "b@x.test", subject: "Sent one", text_body: "sent body" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	await w.addRaw("g2", RAW_ALTERNATIVE);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT Sent");
	const body = (await client.cmd("UID FETCH 1 (BODY.PEEK[TEXT] ENVELOPE)")).text;
	assert.match(body, /ENVELOPE \(.* "Sent one" /);
	assert.match(body, /BODY\[TEXT\] \{14\}\r\nc2VudCBib2R5\r\n/);
	await client.cmd("SELECT INBOX");
	assert.deepEqual((await client.cmd("UID FETCH 2:* (UID)")).text.match(/UID \d+/g), ["UID 2"]);
	assert.deepEqual((await client.cmd("UID FETCH 1:* (UID)")).text.match(/UID \d+/g), ["UID 1", "UID 2"]);
	assert.deepEqual((await client.cmd("UID FETCH 9:* (UID)")).text.match(/UID \d+/g), ["UID 2"], "* is the largest UID, so the range always holds it");
	assert.deepEqual((await client.cmd("FETCH 2:1 (UID)")).text.match(/UID \d+/g), ["UID 1", "UID 2"], "a reversed range is the same range");
});

test("a message the indexer refuses is shown as empty instead of failing the fetch", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", "From: a@x.test\r\nSubject: odd\r\n\r\nx\r\n");
	await w.addRaw("g2", RAW_ALTERNATIVE);
	// Record the refusal the way the indexer does, tied to the message's current columns.
	const [row] = await getDb(w.env).select().from(messages).where(eq(messages.id, "g1"));
	w.sqlite.prepare("INSERT INTO imap_message_cache (message_id, size, envelope, bodystructure, header_size) VALUES ('g1', -1, ?, ?, 0)").run(JSON.stringify({ unindexable: "too deep" }), JSON.stringify({ k: await refusalKey(w.env, row) }));
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const result = (await client.cmd("FETCH 1:2 (UID RFC822.SIZE ENVELOPE BODY.PEEK[])")).text;
	assert.match(result, /\* 1 FETCH \(UID 1 RFC822\.SIZE 0 ENVELOPE \(NIL "Message cannot be displayed" NIL NIL NIL NIL NIL NIL NIL NIL\) BODY\[\] \{0\}\r\n\)/);
	assert.match(result, /\* 2 FETCH \(UID 2 RFC822\.SIZE \d{3}/);
	assert.match((await client.cmd("FETCH 1 BODYSTRUCTURE")).text, /BODYSTRUCTURE \("TEXT" "PLAIN" \("CHARSET" "us-ascii"\) NIL NIL "7BIT" 0 0 NIL NIL NIL NIL\)/);
});

test("SEARCH and UID SEARCH, with ESEARCH return options", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE, { subject: "Quarterly report", from_addr: "boss@x.test", provider_message_id: "<m1@x.test>", created_at: Date.UTC(2024, 0, 10) / 1000 });
	await w.addRaw("g2", RAW_ALTERNATIVE, { subject: "Lunch", from_addr: "friend@x.test", read: 1, starred: 1, created_at: Date.UTC(2024, 0, 20) / 1000, text_body: "pizza 100% good_stuff" });
	await w.addRaw("g3", RAW_EIGHT_BIT, { subject: "Café", from_addr: "cafe@x.test", created_at: Date.UTC(2024, 1, 5) / 1000 });
	w.sqlite.prepare("INSERT INTO imap_message_flags (message_id, answered, keywords) VALUES ('g1', 1, ?)").run('["Orders"]');
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const search = async (criteria) => (await client.cmd(criteria)).text.split("\r\n")[0];
	assert.equal(await search("SEARCH ALL"), "* SEARCH 1 2 3");
	assert.equal(await search("SEARCH UNSEEN"), "* SEARCH 1 3");
	assert.equal(await search("SEARCH SEEN FLAGGED"), "* SEARCH 2");
	assert.equal(await search("SEARCH FROM BOSS"), "* SEARCH 1");
	assert.equal(await search('SEARCH SUBJECT "lunch"'), "* SEARCH 2");
	assert.equal(await search("SEARCH CHARSET UTF-8 SUBJECT {5+}\r\nCaf\xc3\xa9"), "* SEARCH 3");
	assert.equal(await search("SEARCH BODY pizza"), "* SEARCH 2");
	assert.equal(await search('SEARCH BODY "100%"'), "* SEARCH 2", "wildcards in the text are literal");
	assert.equal(await search('SEARCH BODY "_stuff"'), "* SEARCH 2");
	assert.equal(await search('SEARCH BODY "%stuff"'), "* SEARCH");
	assert.equal(await search("SEARCH SINCE 15-Jan-2024"), "* SEARCH 2 3");
	assert.equal(await search("SEARCH BEFORE 15-Jan-2024"), "* SEARCH 1");
	assert.equal(await search("SEARCH ON 20-Jan-2024"), "* SEARCH 2");
	assert.equal(await search("SEARCH SENTSINCE 1-Feb-2024"), "* SEARCH 3");
	assert.equal(await search("SEARCH OR FROM boss FROM friend"), "* SEARCH 1 2");
	assert.equal(await search("SEARCH NOT (FROM boss) UNSEEN"), "* SEARCH 3");
	assert.equal(await search("SEARCH ANSWERED"), "* SEARCH 1");
	assert.equal(await search("SEARCH UNANSWERED"), "* SEARCH 2 3");
	assert.equal(await search("SEARCH KEYWORD Orders"), "* SEARCH 1");
	assert.equal(await search("SEARCH UNKEYWORD Orders"), "* SEARCH 2 3");
	assert.equal(await search("SEARCH DELETED"), "* SEARCH");
	assert.equal(await search("SEARCH RECENT"), "* SEARCH");
	assert.equal(await search("SEARCH 2:3"), "* SEARCH 2 3");
	assert.equal(await search("SEARCH UID 1,3"), "* SEARCH 1 3");
	assert.equal(await search("UID SEARCH FROM friend"), "* SEARCH 2");
	assert.equal(await search("SEARCH HEADER Message-ID m1@x"), "* SEARCH 1", "the threading headers are answered from their columns");
	assert.equal(await search('SEARCH HEADER Subject "caf"'), "* SEARCH 3", "other headers are read from the message");
	assert.equal(await search("SEARCH LARGER 200"), "* SEARCH 1 2");
	assert.equal(await search("SEARCH SMALLER 100"), "* SEARCH 3");
	assert.equal(await search("SEARCH OR HEADER Subject hello FROM friend"), "* SEARCH 1 2");
	assert.equal(await search('SEARCH (FROM boss FROM friend)'), "* SEARCH");
	assert.match((await client.cmd("SEARCH RETURN (MIN MAX COUNT ALL) ALL")).text, /^\* ESEARCH \(TAG "a\d+"\) MIN 1 MAX 3 COUNT 3 ALL 1:3\r\n/);
	assert.match((await client.cmd("UID SEARCH RETURN (COUNT) UNSEEN")).text, /^\* ESEARCH \(TAG "a\d+"\) UID COUNT 2\r\n/);
	assert.match((await client.cmd("SEARCH RETURN () FROM nobody")).text, /^\* ESEARCH \(TAG "a\d+"\)\r\n/);
	assert.equal((await client.cmd("SEARCH CHARSET KOI8-R ALL")).detail, "[BADCHARSET (UTF-8 US-ASCII)] The charset is not supported");
	assert.equal((await client.cmd("SEARCH CHARSET US-ASCII SUBJECT {2+}\r\n\xc3\xa9")).status, "NO");
	for (const bad of ["SEARCH", "SEARCH BOGUS", "SEARCH SINCE 31-Feb-2024", "SEARCH SINCE x", "SEARCH LARGER x", "SEARCH FROM", "SEARCH OR FROM a", "SEARCH HEADER", "SEARCH ()", "SEARCH 0", "SEARCH UID x"]) assert.equal((await client.cmd(bad)).status, "BAD", bad);
	const nested = `${"NOT ".repeat(40)}ALL`;
	assert.equal((await client.cmd(`SEARCH ${nested}`)).status, "BAD", "nesting is limited");
	assert.equal((await client.cmd(`SEARCH SUBJECT {3000+}\r\n${"x".repeat(3000)}`)).status, "BAD", "search strings are limited");
});

test("a header search or size search over more than 2000 messages is refused, one narrowed by another key is not", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const insert = w.sqlite.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, subject, text_body, created_at) VALUES (?, 'u1', 'm1', 'inbound', 'a@b.test', 'me@example.test', 'received', ?, 'x', ?)");
	w.sqlite.exec("BEGIN");
	for (let index = 0; index < 2100; index += 1) insert.run(`bulk${index}`, index === 7 ? "needle" : "hay", 1_700_000_000 + index);
	w.sqlite.exec("COMMIT");
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX", { ms: 20000 });
	assert.equal((await client.cmd("SEARCH LARGER 1", { ms: 20000 })).detail, "[LIMIT] The search is too broad; narrow it");
	assert.equal((await client.cmd("SEARCH SUBJECT needle LARGER 1", { ms: 20000 })).text.split("\r\n")[0], "* SEARCH 8");
});

test("IDLE pushes EXISTS for new mail, EXPUNGE and flag changes, and ends on DONE", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	client.write("idle1 IDLE\r\n");
	await client.expect("+ idling\r\n");
	await w.addRaw("g2", RAW_ALTERNATIVE);
	await client.expect("* 2 EXISTS\r\n");
	w.sqlite.prepare("UPDATE messages SET read = 1 WHERE id = 'g1'").run();
	await client.expect("* 1 FETCH (FLAGS (\\Seen) UID 1)\r\n");
	w.sqlite.prepare("DELETE FROM messages WHERE id = 'g1'").run();
	await client.expect("* 1 EXPUNGE\r\n");
	client.write("DONE\r\n");
	assert.equal((await client.finish("idle1")).status, "OK");
	assert.equal((await client.cmd("NOOP")).text, `a${client.counter} OK NOOP completed\r\n`);
});

test("changes made while no command runs are reported by the next NOOP, never inside a FETCH", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	await w.addRaw("g2", RAW_ALTERNATIVE);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	w.sqlite.prepare("DELETE FROM messages WHERE id = 'g1'").run();
	await w.addRaw("g3", RAW_ALTERNATIVE);
	const fetch = await client.cmd("FETCH 1:* (UID)");
	assert.deepEqual(fetch.text.match(/\* \d+ (FETCH|EXPUNGE|EXISTS)/g), ["* 2 FETCH"], "numbers stay as the client knows them while FETCH runs; a message that is gone is skipped");
	assert.doesNotMatch(fetch.text, /EXPUNGE|EXISTS/);
	const noop = await client.cmd("NOOP");
	assert.match(noop.text, /^\* 1 EXPUNGE\r\n\* 2 EXISTS\r\n\* 0 RECENT\r\n/);
	assert.deepEqual((await client.cmd("FETCH 1:* (UID)")).text.match(/UID \d+/g), ["UID 2", "UID 3"]);
});

test("a delegated shared mailbox is visible, read-only, and its data is only reachable while the delegation stands", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("t1", RAW_ALTERNATIVE, { mailbox_id: "ms", to_addr: "team@other.test", subject: "Team news" });
	await w.addRaw("p1", RAW_ALTERNATIVE, { mailbox_id: "m2", subject: "Private to two" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.match((await client.cmd("SELECT Shared/team@other.test/INBOX")).text, /\* 1 EXISTS/);
	assert.match((await client.cmd("FETCH 1 ENVELOPE")).text, /Hello there/);
	assert.doesNotMatch((await client.cmd("SEARCH SUBJECT private")).text, /1/, "nothing of another mailbox leaks into the search");
	assert.match((await client.cmd("SELECT Shared/TEAM@other.test/inbox")).text, /\* 1 EXISTS/, "address and INBOX are case-insensitive");
	w.sqlite.prepare("DELETE FROM mailbox_access WHERE id = 'ma1'").run();
	const refused = await client.cmd("FETCH 1 ENVELOPE");
	assert.equal(refused.status, "NO");
	assert.match(refused.text, /\* BYE Access to this mailbox was removed/);
	await client.closedPromise;
});

test("a delegation that is removed also drops the folder from the next LIST and SELECT", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	assert.match((await client.cmd('LIST "" "Shared/*"')).text, /team@other\.test/);
	w.sqlite.prepare("DELETE FROM mailbox_access WHERE id = 'ma1'").run();
	assert.doesNotMatch((await client.cmd('LIST "" "Shared/*"')).text, /team@other\.test/);
	assert.equal((await client.cmd("SELECT Shared/team@other.test/INBOX")).status, "NO");
});

test("a key limited to one mailbox sees only that mailbox", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1", mailboxes: ["m1b"] });
	const client = await loggedIn(w, key, "second@example.test");
	t.after(() => client.end());
	const list = (await client.cmd('LIST "" "*"')).text;
	assert.doesNotMatch(list, /Shared|team@other|me@example/);
	assert.equal((await client.cmd("SELECT Shared/team@other.test/INBOX")).status, "NO");
});

test("a revoked app password ends the session within the re-check interval, and a new login fails", async (t) => {
	const w = await world(t, { timeouts: { revalidateMs: 150 } });
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	w.sqlite.prepare("DELETE FROM api_keys WHERE id = 'k1'").run();
	await client.expect("* BYE Credentials revoked\r\n");
	await client.closedPromise;
	const again = await w.open();
	t.after(() => again.end());
	await again.greeting();
	assert.equal((await again.login("me@example.test", key.fullKey)).status, "NO");
});

test("a key re-check that cannot reach the database ends the session instead of letting it go on", async (t) => {
	t.mock.method(console, "warn", () => {});
	const broken = { prepare() { throw new Error("database is down"); } };
	const timed = await world(t, { timeouts: { revalidateMs: 150 } });
	const timedKey = await timed.addKey({ id: "k1" });
	const first = await loggedIn(timed, timedKey);
	t.after(() => first.end());
	await first.cmd("SELECT INBOX");
	timed.env.DB_PRIMARY = broken;
	await first.expect("* BYE Credentials could not be checked\r\n");
	await first.closedPromise;

	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const second = await loggedIn(w, key);
	t.after(() => second.end());
	w.env.DB_PRIMARY = broken;
	const select = await second.cmd("SELECT INBOX");
	assert.equal(select.status, "NO");
	assert.match(select.text, /\* BYE Credentials could not be checked/);
	await second.closedPromise;
});

test("a SELECT still waiting on the database when the client goes away leaves no watcher behind", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const notifier = w.server.notifier;
	const watch = notifier.watch.bind(notifier);
	notifier.watch = async (...args) => {
		const unwatch = await watch(...args);
		await gate;
		return unwatch;
	};
	client.write("s1 SELECT INBOX\r\n");
	const started = Date.now();
	while (notifier.watchedMailboxes === 0 && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(notifier.watchedMailboxes, 1, "the select is waiting");
	client.end();
	while (w.server.connectionCount > 0 && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
	release();
	const settled = Date.now();
	while (notifier.watchedMailboxes > 0 && Date.now() - settled < 3000) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(notifier.watchedMailboxes, 0, "the watcher was released");
});

test("a user disabled mid-session is cut off at the next SELECT", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	w.sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	const select = await client.cmd("SELECT INBOX");
	assert.equal(select.status, "NO");
	assert.match(select.text, /\* BYE Credentials revoked/);
	await client.closedPromise;
});

test("a SEARCH has at most 64 keys, nested ones included", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	assert.equal(MAX_KEYS, 64);
	const many = (count, unit) => Array(count).fill(unit).join(" ");
	assert.equal((await client.cmd(`SEARCH ${many(64, "ALL")}`)).status, "OK");
	const flat = await client.cmd(`SEARCH ${many(65, "ALL")}`);
	assert.deepEqual([flat.status, flat.detail], ["BAD", "The search has too many keys"]);
	assert.equal((await client.cmd(`SEARCH ${many(33, "(ALL)")}`)).status, "BAD", "a group counts for itself and its keys");
	assert.equal((await client.cmd(`SEARCH ${many(22, "OR ALL ALL")}`)).status, "BAD", "OR counts for itself and both keys");
});

test("one command reads at most 2000 messages in total, and no query is run once no candidate is left", async (t) => {
	const w = await world(t);
	for (let index = 0; index < 12; index += 1) await w.addRaw(`s${index}`, RAW_ALTERNATIVE, { subject: `Subject ${index}` });
	const view = await FolderView.open(w.env, "m1", "inbox");
	const criteria = (text) => parseSearchCriteria(text.split(" ").map((value) => ({ type: "ATOM", value })), decoderFor(null));

	// Two header tests over the same 12 messages: 24 reads between them.
	const both = criteria("OR HEADER Subject zzz HEADER Subject yyy");
	await assert.rejects(new SearchEvaluator(w.env, view, 20).run(both), (error) => error.status === "NO" && error.code === "LIMIT");
	assert.deepEqual(await new SearchEvaluator(w.env, view, 24).run(both), []);
	assert.deepEqual(await new SearchEvaluator(w.env, view, 12).run(criteria("HEADER Subject Hello")), view.uids, "a budget of exactly the candidates is enough");
	// The reads of one leaf are not forgiven for the next one, even through NOT.
	await assert.rejects(new SearchEvaluator(w.env, view, 23).run(criteria("NOT HEADER Subject zzz LARGER 1")), (error) => error.code === "LIMIT");

	const statements = [];
	const counted = { ...w.env, DB: new Proxy(w.env.DB, { get: (target, name) => (name === "prepare" ? (sql) => { statements.push(sql); return target.prepare(sql); } : target[name]) }) };
	assert.deepEqual(await new SearchEvaluator(counted, view).run(criteria("SUBJECT nothing-like-this FROM a BODY b SEEN UNSEEN")), []);
	assert.equal(statements.length, 1, `queries for five leaves after an empty first one: ${statements.length}`);
	statements.length = 0;
	assert.deepEqual(await new SearchEvaluator(counted, view).run(criteria("OR SUBJECT nothing-like-this SUBJECT Subject")), view.uids);
	assert.equal(statements.length, 2, "an OR still asks for its second half when the first is empty");
});

test("failed logins are limited: five on one connection end it, ten per minute per address end all of them", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const first = await w.open();
	t.after(() => first.end());
	await first.greeting();
	const results = [];
	for (let attempt = 0; attempt < 4; attempt += 1) results.push((await first.login("me@example.test", `wrong-secret-number-${attempt}-x`)).detail);
	assert.deepEqual(results, Array(4).fill("[AUTHENTICATIONFAILED] Authentication failed"));
	const fifth = await first.login("me@example.test", "wrong-secret-number-4-x");
	assert.match(fifth.text, /\* BYE Too many failed logins/);
	await first.closedPromise;
	const second = await w.open();
	t.after(() => second.end());
	await second.greeting();
	for (let attempt = 0; attempt < 4; attempt += 1) await second.login("me@example.test", `other-wrong-secret-${attempt}-x`);
	const third = await w.open();
	t.after(() => third.end());
	await third.greeting();
	// Nine guesses so far from this address; the tenth is still a guess, the eleventh is refused.
	assert.equal((await third.login("me@example.test", "tenth-wrong-secret-x")).detail, "[AUTHENTICATIONFAILED] Authentication failed");
	assert.equal((await third.login("me@example.test", "eleventh-wrong-secret-x")).detail, "[UNAVAILABLE] Too many login attempts; try again later");
	assert.equal((await third.login("me@example.test", key.fullKey)).detail.startsWith("[UNAVAILABLE]"), true, "even the right password is a guess until it has been verified once");
});

test("the same address's DAV budget is shared: guesses spent elsewhere throttle IMAP", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	for (let attempt = 0; attempt < 10; attempt += 1) await w.env.DEVICE_LOGIN_RATE_LIMIT.limit({ key: "app-auth:ip:127.0.0.1" });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	assert.match((await client.login("me@example.test", key.fullKey)).detail, /^\[UNAVAILABLE\]/);
});

test("per-address, per-user and process connection limits", async (t) => {
	const w = await world(t, { maxPerIp: 3, maxConnections: 100, maxPerUser: 1 });
	const key = await w.addKey({ id: "k1" });
	const open = [];
	for (let index = 0; index < 3; index += 1) {
		const client = await w.open();
		t.after(() => client.end());
		await client.greeting();
		open.push(client);
	}
	const refused = await w.open().catch(() => null);
	if (refused) {
		await refused.closedPromise;
		assert.equal(refused.buffer, "", "a connection over the per-address limit gets no greeting");
	}
	assert.equal((await open[0].login("me@example.test", key.fullKey)).status, "OK");
	assert.equal((await open[1].login("me@example.test", key.fullKey)).detail, "[UNAVAILABLE] Too many connections for this account");
	open[0].end();
	await open[0].closedPromise;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await open[1].login("me@example.test", key.fullKey)).status, "OK", "a slot is free once the first connection closed");

	const total = await world(t, { maxConnections: 2, maxPerIp: 50 });
	const a = await total.open();
	const b = await total.open();
	t.after(() => { a.end(); b.end(); });
	await a.greeting();
	await b.greeting();
	const c = await total.open().catch(() => null);
	if (c) {
		await c.closedPromise;
		assert.equal(c.buffer, "");
	}
});

test("connections are counted per address: an IPv6 client by its /64, a mapped IPv4 address as the IPv4 one", async (t) => {
	const w = await world(t, { maxPerIp: 2 });
	const admit = (address) => w.server.admit({ remoteAddress: address, once() {}, setNoDelay() {} });
	assert.equal(admit("2001:db8:1:2::1"), true);
	assert.equal(admit("2001:db8:1:2:ffff::9"), true);
	assert.equal(admit("2001:db8:1:2::3"), false, "the same /64 shares one allowance");
	assert.equal(admit("2001:db8:1:3::1"), true, "another /64 does not");
	assert.equal(admit("192.0.2.1"), true);
	assert.equal(admit("::ffff:192.0.2.1"), true);
	assert.equal(admit("192.0.2.1"), false, "a dual-stack listener shows IPv4 clients as mapped addresses; they are the same client");
	assert.equal(admit("192.0.2.2"), true);
});

test("the listener binds every interface, IPv6 and IPv4 together, and falls back to IPv4 where IPv6 does not exist", async (t) => {
	const probe = createNetServer();
	const hasIpv6 = await new Promise((resolve) => { probe.once("error", () => resolve(false)); probe.listen(0, "::1", () => probe.close(() => resolve(true))); });
	if (hasIpv6) {
		const w = await world(t, { host: undefined });
		for (const host of ["127.0.0.1", "::1"]) {
			const client = await new Promise((resolve, reject) => { const socket = tlsConnect({ host, port: w.ports.tlsPort, ca, servername: "localhost" }, () => resolve(socket)); socket.once("error", reject); });
			t.after(() => client.destroy());
			assert.ok(client.authorized, host);
		}
	}
	// IPv6 refused by the system: the same port is bound on 0.0.0.0.
	const w = await world(t);
	const tried = [];
	const fake = Object.assign(new EventEmitter(), {
		listen(port, host, done) {
			tried.push(host);
			if (host === "::") queueMicrotask(() => this.emit("error", Object.assign(new Error("no ipv6"), { code: "EAFNOSUPPORT" })));
			else queueMicrotask(done);
		},
		off(...args) { return this.removeListener(...args); },
		address: () => ({ port: 4242 }),
	});
	assert.equal(await w.server.listen(fake, 4242, undefined), 4242);
	assert.deepEqual(tried, ["::", "0.0.0.0"]);
	const failing = Object.assign(new EventEmitter(), { listen() { queueMicrotask(() => this.emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" }))); } });
	await assert.rejects(w.server.listen(failing, 1, undefined), /in use/, "any other error is not hidden by the fallback");
});

test("a connection refused on the STARTTLS port is closed without a greeting", async (t) => {
	const w = await world(t, { tlsPort: null, starttlsPort: 0, maxPerIp: 1 });
	const first = await connectPlainClient(w.ports.starttlsPort);
	t.after(() => first.end());
	await first.greeting();
	const second = await connectPlainClient(w.ports.starttlsPort);
	t.after(() => second.end());
	await second.closedPromise;
	assert.equal(second.buffer, "", "nothing is sent to a client that is over the limit");
});

test("limits before login: long lines, big literals, too many queued commands and silence all end the connection", async (t) => {
	const w = await world(t, { timeouts: { preAuthIdleMs: 300, loginDeadlineMs: 600 } });
	const longLine = await w.open();
	t.after(() => longLine.end());
	await longLine.greeting();
	longLine.write(`a1 LOGIN ${"x".repeat(9000)}\r\n`);
	await longLine.expect("a1 BAD [TOOBIG] Command line too long\r\n");
	await longLine.expect("* BYE Command line too long\r\n");
	await longLine.closedPromise;

	const literal = await w.open();
	t.after(() => literal.end());
	await literal.greeting();
	literal.write("a1 LOGIN {5000}\r\n");
	await literal.expect("a1 BAD [TOOBIG] Literal too large\r\n");
	assert.equal((await literal.cmd("NOOP")).status, "OK", "a refused synchronising literal costs the connection nothing");
	literal.write("a2 LOGIN {4294967295+}\r\n");
	await literal.expect("a2 BAD [TOOBIG] Literal too large\r\n");
	await literal.closedPromise;

	const queue = await w.open();
	t.after(() => queue.end());
	await queue.greeting();
	queue.write("a NOOP\r\n".repeat(1500));
	await queue.expect("* BYE Too many commands queued\r\n");
	await queue.closedPromise;

	const silent = await w.open();
	t.after(() => silent.end());
	await silent.greeting();
	await silent.expect("* BYE Autologout; idle for too long\r\n");
	await silent.closedPromise;

	const slow = await w.open();
	t.after(() => slow.end());
	await slow.greeting();
	const drip = setInterval(() => slow.write(" "), 100);
	await slow.expect("* BYE Login timed out\r\n");
	clearInterval(drip);
	await slow.closedPromise;
});

test("limits after login: a literal over 64 KiB is refused, 64 KiB is fine", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	client.write("b1 SEARCH SUBJECT {65537}\r\n");
	await client.expect("b1 BAD [TOOBIG] Literal too large\r\n");
	assert.equal((await client.cmd("NOOP")).status, "OK");
	assert.equal((await client.cmd("FOO")).detail, "Unknown command");
	assert.equal((await client.cmd("")).status, "BAD");
	client.write("c1 NOOP \"unterminated\r\n");
	await client.expect("c1 BAD Could not parse the command\r\n");
});

test("a client that stops reading cannot make the server queue output without bound; it is dropped after the stall limit", async (t) => {
	const w = await world(t, { commandsPerSecond: 1_000_000, timeouts: { writeStallMs: 500 } });
	const key = await w.addKey({ id: "k1" });
	const insert = w.sqlite.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, subject, text_body, created_at) VALUES (?, 'u1', 'm1', 'inbound', 'a@b.test', 'me@example.test', 'received', 'x', 'x', ?)");
	w.sqlite.exec("BEGIN");
	for (let index = 0; index < 4000; index += 1) insert.run(`bulk${index}`, 1_700_000_000 + index);
	w.sqlite.exec("COMMIT");
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX", { ms: 20000 });
	const connection = [...w.server.connections][0];
	let queued = 0;
	const sampler = setInterval(() => { queued = Math.max(queued, connection.socket.writableLength); }, 2);
	t.after(() => clearInterval(sampler));
	client.socket.pause();
	// About 24 KiB of answer per command, 900 commands: far more than the socket and the kernel hold.
	for (let batch = 0; batch < 3; batch += 1) client.write("s SEARCH ALL\r\n".repeat(300));
	const started = Date.now();
	while (w.server.connectionCount > 0 && Date.now() - started < 15000) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(w.server.connectionCount, 0, "the connection was closed after the stall limit");
	assert.ok(queued > 0);
	assert.ok(queued <= 1024 * 1024 + 64 * 1024, `most output queued at once: ${queued} bytes`);
});

test("a client that never reads cannot make the server queue refusals: a run of oversize literals ends the connection", async (t) => {
	const w = await world(t, { commandsPerSecond: 1_000_000 });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	const connection = [...w.server.connections][0];
	let queued = 0;
	const sampler = setInterval(() => { queued = Math.max(queued, connection.socket.writableLength); }, 2);
	t.after(() => clearInterval(sampler));
	client.socket.pause();
	const chunk = "a {5000}\r\n".repeat(500);
	for (let batch = 0; batch < 400 && w.server.connectionCount > 0; batch += 1) {
		client.write(chunk);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	const started = Date.now();
	while (w.server.connectionCount > 0 && Date.now() - started < 10000) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(w.server.connectionCount, 0, "the connection was closed");
	assert.ok(queued <= 1024 * 1024 + 64 * 1024, `most output queued at once: ${queued} bytes`);
});

test("a client that sends an oversize literal now and then is refused each time and stays connected", async (t) => {
	const w = await world(t, { commandsPerSecond: 1_000_000 });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	for (let round = 0; round < 12; round += 1) {
		client.write("a {5000}\r\n");
		await client.expect("a BAD [TOOBIG] Literal too large\r\n");
		assert.equal((await client.cmd("NOOP")).status, "OK");
	}
});

test("commands past the per-connection rate are delayed, not refused", async (t) => {
	const w = await world(t, { commandsPerSecond: 20 });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	const started = Date.now();
	client.write("n NOOP\r\n".repeat(60));
	for (let index = 0; index < 60; index += 1) await client.expect("n OK NOOP completed\r\n");
	assert.ok(Date.now() - started >= 1500, `60 commands at 20 a second take about two seconds, took ${Date.now() - started} ms`);
});

test("ID, ENABLE, CHECK, CLOSE, UNSELECT, SUBSCRIBE", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	assert.match((await client.cmd('ID ("name" "Thunderbird" "version" "128")')).text, /^\* ID \("name" "Mailflare" "vendor" "Mailflare"\)\r\n/);
	assert.equal((await client.cmd("ID NIL")).status, "OK");
	assert.equal((await client.cmd(`ID (${'"k" "v" '.repeat(40)})`)).status, "BAD", "too many fields");
	assert.equal((await client.cmd("ENABLE CONDSTORE")).status, "BAD", "log in first");
	await client.login("me@example.test", key.fullKey);
	assert.equal((await client.cmd("ENABLE CONDSTORE")).text.split("\r\n")[0], "* ENABLED");
	assert.equal((await client.cmd("CHECK")).status, "BAD", "no mailbox selected");
	await client.cmd("SELECT INBOX");
	assert.equal((await client.cmd("CHECK")).status, "OK");
	assert.equal((await client.cmd("UNSELECT")).status, "OK");
	assert.equal((await client.cmd("FETCH 1 FLAGS")).status, "BAD");
	await client.cmd("SELECT INBOX");
	assert.equal((await client.cmd("CLOSE")).status, "OK");
	assert.equal((await client.cmd("CLOSE")).status, "BAD");
	assert.equal((await client.cmd("SUBSCRIBE INBOX")).status, "OK");
	assert.equal((await client.cmd("UNSUBSCRIBE INBOX")).status, "OK");
});

test("the audit log records the login with the client's ID name, once", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await w.open();
	t.after(() => client.end());
	await client.greeting();
	await client.cmd('ID ("name" "Thunderbird")');
	await client.login("me@example.test", key.fullKey);
	const row = w.sqlite.prepare("SELECT action, metadata FROM audit_logs WHERE action = 'auth.app_password_login'").get();
	assert.deepEqual(JSON.parse(row.metadata), { ipAddress: "127.0.0.1", device: "Mail app", platform: "Thunderbird", keyId: "k1" });
});

test("imapflow can log in, list, open a mailbox and download a message", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	const flow = new ImapFlow({ host: "127.0.0.1", port: w.ports.tlsPort, secure: true, auth: { user: "me@example.test", pass: key.fullKey }, tls: { ca, servername: "localhost" }, logger: false });
	flow.on("error", () => {});
	await flow.connect();
	t.after(async () => { await flow.logout().catch(() => {}); });
	const folders = await flow.list();
	assert.ok(folders.some((folder) => folder.path === "INBOX"));
	assert.ok(folders.find((folder) => folder.path === "Sent")?.specialUse === "\\Sent");
	const lock = await flow.getMailboxLock("INBOX");
	try {
		assert.equal(flow.mailbox.exists, 1);
		assert.equal(flow.mailbox.readOnly, false);
		const message = await flow.fetchOne("1", { envelope: true, bodyStructure: true, uid: true, source: true });
		assert.equal(message.envelope.subject, "Hello there");
		assert.equal(message.bodyStructure.childNodes.length, 2);
		assert.equal(message.source.toString(), RAW_ALTERNATIVE);
	} finally {
		lock.release();
	}
});

test("STARTTLS port: login is disabled until TLS, bytes pipelined after STARTTLS end the connection", async (t) => {
	const w = await world(t, { tlsPort: null, starttlsPort: 0 });
	const key = await w.addKey({ id: "k1" });
	const plain = await connectPlainClient(w.ports.starttlsPort);
	t.after(() => plain.end());
	assert.match(await plain.greeting(), /\[CAPABILITY IMAP4rev1 SASL-IR LITERAL\+ ID ENABLE STARTTLS LOGINDISABLED\]/);
	assert.equal((await plain.cmd(`LOGIN "me@example.test" "${key.fullKey}"`)).detail, "[PRIVACYREQUIRED] Log in only over TLS");
	assert.equal((await plain.cmd("AUTHENTICATE PLAIN AGE=")).detail, "[PRIVACYREQUIRED] Log in only over TLS");
	assert.equal((await plain.cmd("SELECT INBOX")).detail, "Log in first");
	assert.equal((await plain.cmd("STARTTLS x")).status, "BAD");
	assert.equal((await plain.cmd("STARTTLS")).detail, "Begin TLS negotiation now");
	const secure = await upgradeToTls(plain, ca);
	t.after(() => secure.end());
	const capability = await secure.cmd("CAPABILITY");
	assert.match(capability.text, /AUTH=PLAIN/);
	assert.doesNotMatch(capability.text, /STARTTLS|LOGINDISABLED/);
	assert.equal((await secure.cmd("STARTTLS")).status, "BAD");
	assert.equal((await secure.login("me@example.test", key.fullKey)).status, "OK");

	const injected = await connectPlainClient(w.ports.starttlsPort);
	t.after(() => injected.end());
	await injected.greeting();
	injected.write(`s1 STARTTLS\r\ns2 LOGIN "me@example.test" "${key.fullKey}"\r\n`);
	await injected.expect("* BYE Data after STARTTLS\r\n");
	assert.doesNotMatch(injected.buffer, /OK \[CAPABILITY/, "the command sent in the clear was not run");
	await injected.closedPromise;
});

test("LOGIN without TLS is allowed only with IMAP_ALLOW_PLAINTEXT on a loopback bind", async (t) => {
	const local = await world(t, { tlsPort: null, starttlsPort: 0, allowPlaintext: true, host: "127.0.0.1" });
	const key = await local.addKey({ id: "k1" });
	const client = await connectPlainClient(local.ports.starttlsPort);
	t.after(() => client.end());
	assert.match(await client.greeting(), /AUTH=PLAIN/);
	assert.equal((await client.login("me@example.test", key.fullKey)).status, "OK");
	const warnings = [];
	const original = console.warn;
	console.warn = (...parts) => warnings.push(parts.join(" "));
	let remote;
	try {
		remote = await world(t, { tlsPort: null, starttlsPort: 0, allowPlaintext: true, host: "0.0.0.0" });
	} finally {
		console.warn = original;
	}
	assert.match(warnings.join("\n"), /IMAP_ALLOW_PLAINTEXT is ignored/);
	const key2 = await remote.addKey({ id: "k1" });
	const second = await connectPlainClient(remote.ports.starttlsPort);
	t.after(() => second.end());
	assert.match(await second.greeting(), /STARTTLS LOGINDISABLED/);
	assert.equal((await second.login("me@example.test", key2.fullKey)).detail, "[PRIVACYREQUIRED] Log in only over TLS");
});

test("shutdown says goodbye to every session and closes the listeners", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	await client.cmd("SELECT INBOX");
	client.write("idle IDLE\r\n");
	await client.expect("+ idling\r\n");
	await w.server.stop();
	await client.expect("* BYE Server shutting down\r\n");
	await client.closedPromise;
	await assert.rejects(connectTlsClient(w.ports.tlsPort, ca));
});

test("a TLS client that never finishes the handshake still counts against the address limit and is dropped", async (t) => {
	const w = await world(t, { maxPerIp: 2 });
	const { connect } = await import("node:net");
	const stalled = [connect(w.ports.tlsPort, "127.0.0.1"), connect(w.ports.tlsPort, "127.0.0.1")];
	for (const socket of stalled) socket.on("error", () => {});
	t.after(() => stalled.forEach((socket) => socket.destroy()));
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(w.server.connectionCount, 2);
	const refused = await w.open().then((client) => { client.end(); return false; }, () => true);
	assert.equal(refused, true, "a third connection from the address is refused while two handshakes hang");
});

test("new mail announced through the realtime hub reaches an IDLE client without waiting for the poll", async (t) => {
	const heard = new Set();
	const realtime = { subscribe: (_user, listener) => { heard.add(listener); return () => heard.delete(listener); } };
	const w = await world(t, { pollMs: 600_000, realtime });
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	client.write("i IDLE\r\n");
	await client.expect("+ idling\r\n");
	assert.equal(heard.size, 1, "the session listens to the hub for its user");
	await w.addRaw("g1", RAW_ALTERNATIVE);
	for (const listener of heard) listener({ type: "new_message" });
	await client.expect("* 1 EXISTS\r\n", 2000);
	client.write("DONE\r\n");
	await client.finish("i");
	client.end();
	await client.closedPromise;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(heard.size, 0, "and stops when the session ends");
});

test("a renewed certificate is served to new connections, open ones carry on", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const old = await loggedIn(w, key);
	t.after(() => old.end());
	const newKey = join(directory, "key2.pem");
	const newCert = join(directory, "cert2.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", newKey, "-out", newCert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
	const second = { key: readFileSync(newKey), cert: readFileSync(newCert) };
	w.server.reloadCertificate(second);
	const fresh = await connectTlsClient(w.ports.tlsPort, second.cert);
	t.after(() => fresh.end());
	await fresh.greeting();
	await assert.rejects(connectTlsClient(w.ports.tlsPort, ca), "the old certificate is not trusted by the new one's chain");
	assert.equal((await old.cmd("NOOP")).status, "OK");
});

test("a deeply nested command is refused quickly and the connection stays usable", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	const started = Date.now();
	assert.equal((await client.cmd(`SEARCH ${"(".repeat(20000)}ALL${")".repeat(20000)}`)).status, "BAD");
	assert.equal((await client.cmd(`FETCH 1 ${"(".repeat(20000)}FLAGS${")".repeat(20000)}`)).status, "BAD");
	assert.equal((await client.cmd(`FETCH 1 BODY[${"1.".repeat(20000)}1]`)).status, "BAD");
	assert.ok(Date.now() - started < 2000);
	assert.equal((await client.cmd("NOOP")).status, "OK");
});

test("a message set made of many ranges is bounded and a huge range costs nothing", async (t) => {
	const w = await world(t);
	const key = await w.addKey({ id: "k1" });
	await w.addRaw("g1", RAW_ALTERNATIVE);
	const client = await loggedIn(w, key);
	t.after(() => client.end());
	await client.cmd("SELECT INBOX");
	assert.equal((await client.cmd(`FETCH ${Array(1500).fill("1").join(",")} UID`)).status, "BAD");
	const started = Date.now();
	assert.equal((await client.cmd("UID FETCH 1:4294967295 (UID)")).text.match(/\* \d+ FETCH/g).length, 1);
	assert.ok(Date.now() - started < 500);
});

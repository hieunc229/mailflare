import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import bodystructure from "../server/imap/vendor/imapkit/bodystructure.js";
import { normalizeLineBreaks, parseTree } from "../server/imap/vendor/imapkit/mimeparser.js";
import { makeHelpers, seedWorld } from "./helpers/imap-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-session-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { parseSequenceSet, selectByNumber, selectByUid, resolveRanges, compactSet } from "./src/lib/imap/sets.ts";
			export { matchesPattern } from "./server/imap/commands/mailbox.ts";
			export { withoutExtensions, internalDate } from "./server/imap/commands/fetch.ts";
			export { FolderView, flagsOf } from "./src/lib/imap/view.ts";
			export { loadNamespace, findFolder } from "./src/lib/imap/namespace.ts";
			export { authenticateImap } from "./src/lib/imap/auth.ts";
			export { Notifier } from "./server/imap/notifier.ts";
			export { RealtimeHubRegistry } from "./server/runtime/realtime.ts";
			export { watchCertificate } from "./server/runtime/tls-files.ts";
			export { syncMailbox } from "./src/lib/imap/sync.ts";
			export { readImapConfig, imapIsOffered } from "./src/lib/imap/config.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-session-test-entry.ts",
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
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function world(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	seedWorld(database.db);
	return { sqlite: database.db, env: { DB: database }, ...makeHelpers(database.db, m.generateAppPassword) };
}

// ---- Sequence sets ----

test("sequence sets: valid forms, bounds and rejection", () => {
	assert.deepEqual(m.parseSequenceSet("1"), [{ from: 1, to: 1 }]);
	assert.deepEqual(m.parseSequenceSet("2:4,*,7:*"), [{ from: 2, to: 4 }, { from: "*", to: "*" }, { from: 7, to: "*" }]);
	for (const bad of ["", "0", "1:", ":1", "1::2", "1:2:3", "a", "1,,2", "-1", "1 2", "4294967296", "12345678901", "1.5", "*:*:*"]) assert.equal(m.parseSequenceSet(bad), null, bad);
	assert.equal(m.parseSequenceSet("4294967295")[0].from, 4294967295);
	assert.equal(m.parseSequenceSet(Array(1001).fill("1").join(",")), null, "at most 1000 ranges");
	assert.equal(m.parseSequenceSet(Array(1000).fill("1").join(",")).length, 1000);
});

test("sequence sets: selecting by number and by UID", () => {
	const uids = [3, 5, 6, 9, 20];
	assert.deepEqual(m.selectByNumber(m.parseSequenceSet("2:3"), 5), [2, 3]);
	assert.deepEqual(m.selectByNumber(m.parseSequenceSet("4:*"), 5), [4, 5]);
	assert.deepEqual(m.selectByNumber(m.parseSequenceSet("5:2,9"), 5), [2, 3, 4, 5], "reversed, and a number past the end is ignored");
	assert.deepEqual(m.selectByNumber(m.parseSequenceSet("1:*"), 0), [], "an empty folder selects nothing");
	assert.deepEqual(m.selectByUid(m.parseSequenceSet("5:9"), uids), [2, 3, 4]);
	assert.deepEqual(m.selectByUid(m.parseSequenceSet("10:*"), uids), [5], "* is the largest UID, so the range holds it");
	assert.deepEqual(m.selectByUid(m.parseSequenceSet("21:30"), uids), []);
	assert.deepEqual(m.selectByUid(m.parseSequenceSet("6,3,6"), uids), [1, 3]);
	assert.equal(m.compactSet([1, 2, 3, 5, 7, 8]), "1:3,5,7:8");
});

// ---- LIST patterns ----

test("LIST patterns: * crosses the delimiter, % does not", () => {
	assert.equal(m.matchesPattern("*", "a/b/c"), true);
	assert.equal(m.matchesPattern("%", "a/b"), false);
	assert.equal(m.matchesPattern("%", "a"), true);
	assert.equal(m.matchesPattern("a/%", "a/b"), true);
	assert.equal(m.matchesPattern("a/%", "a/b/c"), false);
	assert.equal(m.matchesPattern("a/*", "a/b/c"), true);
	assert.equal(m.matchesPattern("INBOX", "INBOX"), true);
	assert.equal(m.matchesPattern("INBOX", "inbox"), false);
	assert.equal(m.matchesPattern("*b*", "abc"), true);
	assert.equal(m.matchesPattern("", ""), true);
	assert.equal(m.matchesPattern("a*", ""), false);
	assert.equal(m.matchesPattern("*a*a*a*a*a*a*a*a*b", "a".repeat(1000)), false, "long pattern against a long name");
	assert.equal(m.matchesPattern("*a*a*a*a*a*a*a*a*b", `${"a".repeat(1000)}b`), true);
});

// ---- BODY without extension data ----

const MESSAGES = {
	alternative: ["Content-Type: multipart/alternative; boundary=A", "", "--A", "Content-Type: text/plain", "", "hi", "--A", "Content-Type: text/html; charset=utf-8", "Content-Disposition: inline", "Content-Language: en", "", "<p>hi</p>", "--A--", ""],
	nested: ["Content-Type: multipart/mixed; boundary=B", "", "--B", "Content-Type: message/rfc822", "", "Content-Type: multipart/alternative; boundary=I", "", "--I", "Content-Type: text/plain", "", "in", "--I--", "--B", "Content-Type: application/pdf; name=a.pdf", "Content-Disposition: attachment; filename=a.pdf", "Content-MD5: abc", "", "AAAA", "--B--", ""],
	single: ["Content-Type: text/plain; charset=us-ascii", "Content-ID: <x>", "", "plain", ""],
};
test("BODY drops the extension data the way the vendored builder does for BODY, for every shape", () => {
	for (const [name, lines] of Object.entries(MESSAGES)) {
		const tree = parseTree(normalizeLineBreaks(lines.join("\r\n")));
		const full = JSON.parse(JSON.stringify(m.withoutExtensions(bodystructure(tree))));
		const expected = JSON.parse(JSON.stringify(bodystructure(tree, { body: true })));
		assert.deepEqual(full, expected, name);
	}
});

test("INTERNALDATE is in UTC with a two-digit day", () => {
	assert.equal(m.internalDate(new Date(Date.UTC(2024, 0, 5, 9, 8, 7))), "05-Jan-2024 09:08:07 +0000");
});

// ---- Flags and the folder view ----

test("flags come from the columns, the IMAP-only table and well-formed keywords only", () => {
	const row = (overrides) => ({ id: "x", read: false, starred: false, status: "received", createdAt: new Date(), answered: null, forwarded: null, deleted: null, keywords: null, ...overrides });
	assert.deepEqual(m.flagsOf(row({})), []);
	assert.deepEqual(m.flagsOf(row({ read: true, starred: true, status: "draft", answered: true, deleted: true, forwarded: true })), ["\\Seen", "\\Flagged", "\\Draft", "\\Answered", "\\Deleted", "$Forwarded"]);
	assert.deepEqual(m.flagsOf(row({ keywords: JSON.stringify(["Work", "bad flag", "x\r\n* BYE", "a(b)", "", "ok-1", "ok-1", 5, "\\Seen", "a".repeat(65)]) })), ["Work", "ok-1"], "anything that is not an atom is dropped, so a keyword cannot inject a response");
	assert.deepEqual(m.flagsOf(row({ keywords: "not json" })), []);
});

test("the folder view reports expunges (highest first), new messages and flag changes, and stays put between refreshes", async (t) => {
	const { env, sqlite, addMessage } = await world(t);
	const ids = [addMessage(), addMessage(), addMessage()];
	const view = await m.FolderView.open(env, "m1", "inbox");
	assert.deepEqual(view.uids, [1, 2, 3]);
	assert.equal(view.exists, 3);
	assert.deepEqual(await view.refresh(), { expunged: [], exists: null, flagged: [], uidvalidityChanged: false });

	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[0]);
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[2]);
	addMessage();
	sqlite.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(ids[1]);
	assert.deepEqual(view.uids, [1, 2, 3], "nothing changes until refresh");
	assert.deepEqual(await view.refresh(), { expunged: [3, 1], exists: 2, flagged: [{ msn: 1, uid: 2 }], uidvalidityChanged: false });
	assert.deepEqual(view.uids, [2, 4]);

	sqlite.prepare("UPDATE imap_folder_state SET uidvalidity = uidvalidity + 5 WHERE id = 'm1:inbox'").run();
	sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(ids[1]);
	assert.equal((await view.refresh()).uidvalidityChanged, true);
});

test("opening a folder nothing was ever delivered to gives it UIDVALIDITY and UIDNEXT 1", async (t) => {
	const { env, sqlite } = await world(t);
	sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f9', 'u1', 'm1', 'Empty', 1)").run();
	const view = await m.FolderView.open(env, "m1", "f:f9");
	assert.equal(view.exists, 0);
	assert.equal(view.uidNext, 1);
	assert.ok(view.uidvalidity > 0);
});

// ---- Namespace and access ----

test("the namespace holds only what the user may access; a lookalike name finds nothing", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "k1" });
	const result = await m.authenticateImap(env, { username: "me@example.test", secret: key.fullKey, ip: null, client: "x" });
	const ns = await m.loadNamespace(env, result.identity);
	const names = ns.folders.map((folder) => folder.name);
	assert.ok(names.includes("INBOX") && names.includes("Shared/team@other.test/INBOX") && names.includes("Shared/second@example.test/Sent"));
	assert.equal(names.some((name) => name.includes("two@other.test")), false);
	assert.equal(m.findFolder(ns, "Shared/two@other.test/INBOX"), null);
	assert.equal(m.findFolder(ns, "SHARED/Team@Other.Test/inbox")?.mailboxId, "ms");
	assert.equal(m.findFolder(ns, "inbox")?.mailboxId, "m1");
	assert.equal(m.findFolder(ns, "Inbox/x"), null);
	assert.equal(m.findFolder(ns, "Shared/team@other.test/INBOX/..")?.name, undefined);
	assert.equal(ns.folders.find((folder) => folder.name === "Shared/team@other.test/INBOX").permission, "read_only");
	// Taking the mailbox away from the user takes its folders away on the next load.
	sqlite.prepare("DELETE FROM mailbox_access").run();
	const again = await m.loadNamespace(env, result.identity);
	assert.equal(again.folders.some((folder) => folder.name.includes("team@other.test")), false);
	sqlite.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'm1'").run();
	assert.equal(await m.loadNamespace(env, result.identity), null, "the login mailbox itself was disabled");
});

// ---- Notifier and realtime ----

test("the notifier reports a change once per revision, to every watcher of that mailbox, and stops after unwatch", async (t) => {
	const { env, sqlite, addMessage } = await world(t);
	const notifier = new m.Notifier(env, 60_000);
	const seen = [];
	const stopA = await notifier.watch("m1", "u1", () => seen.push("a"));
	const stopB = await notifier.watch("m1", "u1", () => seen.push("b"));
	await notifier.check();
	assert.deepEqual(seen, [], "no change yet");
	addMessage();
	await notifier.check();
	assert.deepEqual(seen, ["a", "b"]);
	await notifier.check();
	assert.deepEqual(seen, ["a", "b"], "the same revision is not reported twice");
	stopA();
	addMessage({ mailbox_id: "m1" });
	await notifier.check();
	assert.deepEqual(seen, ["a", "b", "b"]);
	stopB();
	assert.equal(notifier.watchedMailboxes, 0);
	stopB();
	addMessage();
	await notifier.check();
	assert.equal(seen.length, 3);
	void sqlite;
});

test("a change between the caller's own read and watch() is not lost; other mailboxes do not wake a watcher", async (t) => {
	const { env, addMessage } = await world(t);
	const notifier = new m.Notifier(env, 60_000);
	const seen = [];
	await notifier.watch("m1", "u1", () => seen.push("m1"));
	addMessage({ mailbox_id: "m2" });
	await notifier.check();
	assert.deepEqual(seen, []);
	addMessage({ mailbox_id: "m1" });
	await notifier.check();
	assert.deepEqual(seen, ["m1"]);
});

test("a listener that throws does not stop the others", async (t) => {
	const { env, addMessage } = await world(t);
	const notifier = new m.Notifier(env, 60_000);
	const seen = [];
	const warn = console.warn;
	console.warn = () => {};
	t.after(() => { console.warn = warn; });
	await notifier.watch("m1", "u1", () => { throw new Error("boom"); });
	await notifier.watch("m1", "u1", () => seen.push("ok"));
	addMessage();
	await notifier.check();
	assert.deepEqual(seen, ["ok"]);
});

test("the realtime hub's notify reaches in-process subscribers and the notifier checks at once", async (t) => {
	const { env, addMessage } = await world(t);
	const registry = new m.RealtimeHubRegistry();
	const heard = [];
	const stop = registry.subscribe("u1", (payload) => heard.push(payload));
	registry.notify("u1", { type: "new_message" });
	registry.notify("u2", { type: "other" });
	assert.deepEqual(heard, [{ type: "new_message" }]);
	stop();
	registry.notify("u1", { type: "again" });
	assert.equal(heard.length, 1);
	registry.subscribe("u1", () => { throw new Error("listener failure is contained"); });
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	registry.notify("u1", {});

	const notifier = new m.Notifier(env, 60_000, registry);
	t.after(() => notifier.stop());
	const seen = [];
	await notifier.watch("m1", "u1", () => seen.push("changed"));
	addMessage();
	registry.notify("u1", { type: "new_message" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(seen, ["changed"], "no poll was needed");
	registry.notify("u2", {});
});

test("the realtime subscription ends with the last watcher of the user", async (t) => {
	const { env } = await world(t);
	let live = 0;
	const realtime = { subscribe: () => { live += 1; return () => { live -= 1; }; } };
	const notifier = new m.Notifier(env, 60_000, realtime);
	const first = await notifier.watch("m1", "u1", () => {});
	const second = await notifier.watch("m1b", "u1", () => {});
	assert.equal(live, 1, "one subscription per user");
	first();
	assert.equal(live, 1);
	second();
	assert.equal(live, 0);
});

// ---- Certificate files ----

test("a renewed certificate is picked up when either file changes, and a bad one keeps the old", async (t) => {
	const keyPath = join(directory, "reload-key.pem");
	const certPath = join(directory, "reload-cert.pem");
	const make = (subject) => execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", `/CN=${subject}`], { stdio: "ignore" });
	make("one");
	const applied = [];
	let refuse = false;
	const stop = m.watchCertificate({ keyPath, certPath }, 40, (material) => {
		if (refuse) throw new Error("the new certificate does not match its key");
		applied.push(material.cert.toString());
	});
	t.after(stop);
	const log = console.log;
	const error = console.error;
	console.log = () => {};
	console.error = () => {};
	t.after(() => { console.log = log; console.error = error; });
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const touch = (seconds) => utimesSync(certPath, new Date(Date.now() + seconds * 1000), new Date(Date.now() + seconds * 1000));
	await wait(150);
	assert.equal(applied.length, 0, "unchanged files are left alone");
	make("two");
	touch(5);
	await wait(200);
	assert.equal(applied.length, 1);
	await wait(150);
	assert.equal(applied.length, 1, "applied once per change");
	refuse = true;
	make("three");
	touch(10);
	await wait(150);
	assert.equal(applied.length, 1, "a certificate that cannot be applied is not applied, and the watcher keeps running");
	refuse = false;
	await wait(150);
	assert.equal(applied.length, 2, "and it is tried again, so a fixed file is picked up");
});

// ---- Configuration ----

test("IMAP settings: off by default, ports, limits, and the loopback-only plain mode", () => {
	assert.deepEqual({ ...m.readImapConfig({}), hasCertificate: undefined }, { enabled: false, port: 993, starttlsPort: 0, host: undefined, hostname: undefined, maxConnections: 500, maxMessageSize: 36 * 1024 * 1024, allowPlaintext: false, hasCertificate: undefined });
	const on = m.readImapConfig({ IMAP_ENABLED: "1", IMAP_PORT: "0", IMAP_STARTTLS_PORT: "143", IMAP_HOST: " 127.0.0.1 ", MAIL_HOSTNAME: "mail.x", IMAP_MAX_CONNECTIONS: "50", IMAP_ALLOW_PLAINTEXT: "1", SMTP_TLS_KEY: "k", SMTP_TLS_CERT: "c" });
	assert.deepEqual(on, { enabled: true, port: 0, starttlsPort: 143, host: "127.0.0.1", hostname: "mail.x", maxConnections: 50, maxMessageSize: 36 * 1024 * 1024, allowPlaintext: true, hasCertificate: true });
	for (const bad of ["abc", "-1", "70000", "1.5"]) assert.equal(m.readImapConfig({ IMAP_PORT: bad }).port, 993, bad);
	for (const bad of ["0", "-3", "x", ""]) assert.equal(m.readImapConfig({ IMAP_MAX_CONNECTIONS: bad }).maxConnections, 500, bad);
	// The APPEND limit follows IMAP_MAX_MESSAGE_SIZE, then SMTP_MAX_SIZE, and is never above the in-flight budget.
	assert.equal(m.readImapConfig({ SMTP_MAX_SIZE: "1000" }).maxMessageSize, 1000);
	assert.equal(m.readImapConfig({ SMTP_MAX_SIZE: "1000", IMAP_MAX_MESSAGE_SIZE: "2000" }).maxMessageSize, 2000);
	assert.equal(m.readImapConfig({ IMAP_MAX_MESSAGE_SIZE: String(10 * 1024 ** 3) }).maxMessageSize, 512 * 1024 * 1024);
	for (const bad of ["0", "-1", "x", "1.5"]) assert.equal(m.readImapConfig({ IMAP_MAX_MESSAGE_SIZE: bad }).maxMessageSize, 36 * 1024 * 1024, bad);
	assert.equal(m.imapIsOffered({ IMAP_ENABLED: "1" }), false);
	assert.equal(m.imapIsOffered({ IMAP_ENABLED: "1", SMTP_TLS_KEY: "k", SMTP_TLS_CERT: "c" }), true);
});

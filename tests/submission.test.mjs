import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import nodemailer from "nodemailer";
import { connectSmtpPlain, connectSmtpTls, upgradeSmtp } from "./helpers/smtp-client.mjs";
import { makeHelpers, seedWorld } from "./helpers/imap-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-submission-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SubmissionServer, watchOutput } from "./server/submission.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { clearLoginAuditMemory } from "./src/lib/imap/auth.ts";
			export { clearSubmissionMemory, findSubmission } from "./src/lib/imap/sent-dedupe.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { openFileBucket } from "./server/runtime/file-bucket.ts";
			export { openRateLimiter } from "./server/runtime/misc.ts";
		`,
		resolveDir: root,
		sourcefile: "submission-test-entry.ts",
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

const keyPath = join(directory, "key.pem");
const certPath = join(directory, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
const certificate = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
const ca = certificate.cert;

const message = ({ from = "me@example.test", to = "a@x.test", subject = "Hello", id = "<c1@mail.local>", body = "plain body" } = {}) => ["From: " + from, "To: " + to, "Subject: " + subject, "Message-ID: " + id, "Date: Mon, 1 Jan 2024 10:00:00 +0000", "", body].join("\r\n");

async function world(t, options = {}, keyOptions = {}) {
	m.clearApiKeyVerificationCache();
	m.clearLoginAuditMemory();
	m.clearSubmissionMemory();
	const database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	seedWorld(database.db);
	database.db.prepare("UPDATE domains SET sending_provider = 'cloudflare'").run();
	const helpers = makeHelpers(database.db, m.generateAppPassword);
	const sent = [];
	const env = {
		DB: database,
		BUCKET: m.openFileBucket(mkdtempSync(join(directory, "blobs-"))),
		MAILFLARE_RUNTIME: "node",
		APP_URL: "https://mail.example.test",
		DEVICE_LOGIN_RATE_LIMIT: m.openRateLimiter(10, 60),
		EMAIL: {
			send: async (mail) => {
				sent.push(mail);
				return { messageId: `<cf-${sent.length}@example.test>` };
			},
		},
	};
	const key = await helpers.addKey({ id: "ks", scopes: ["submission"], ...keyOptions });
	const server = new m.SubmissionServer({ env, hostname: "mail.example.test", tlsPort: 0, starttlsPort: 0, host: "127.0.0.1", certificate, failureDelayMs: 0, ...options });
	const ports = await server.start();
	t.after(async () => {
		await server.stop();
		database.db.close();
		m.clearApiKeyVerificationCache();
	});
	const warnings = [];
	t.mock.method(console, "warn", (...args) => void warnings.push(args.join(" ")));
	const w = { ...helpers, sqlite: database.db, env, server, ports, sent, key, warnings };
	w.implicit = async () => connectSmtpTls(ports.tlsPort, ca);
	w.starttls = async () => {
		const plain = await connectSmtpPlain(ports.starttlsPort);
		assert.equal((await plain.reply()).code, 220);
		assert.equal((await plain.cmd("EHLO client.test")).code, 250);
		assert.equal((await plain.cmd("STARTTLS")).code, 220);
		const secure = await upgradeSmtp(plain, ca);
		assert.equal((await secure.cmd("EHLO client.test")).code, 250);
		return secure;
	};
	/** An authenticated session on the TLS port. */
	w.session = async (user = "me@example.test", secret = key.fullKey) => {
		const client = await w.implicit();
		assert.equal((await client.reply()).code, 220);
		assert.equal((await client.cmd("EHLO client.test")).code, 250);
		const auth = await client.authPlain(user, secret);
		assert.equal(auth.code, 235, auth.text);
		return client;
	};
	/** MAIL / RCPT / DATA / body on an open session; resolves with the final reply. */
	w.send = async (client, { mailFrom = "me@example.test", recipients = ["a@x.test"], raw = message() } = {}) => {
		const mail = await client.cmd(`MAIL FROM:<${mailFrom}>`);
		if (mail.code !== 250) return mail;
		for (const recipient of recipients) {
			const rcpt = await client.cmd(`RCPT TO:<${recipient}>`);
			if (rcpt.code !== 250) return rcpt;
		}
		const data = await client.cmd("DATA");
		if (data.code !== 354) return data;
		return client.data(raw.replace(/\r\n\./g, "\r\n.."));
	};
	return w;
}

test("the STARTTLS port offers STARTTLS and no AUTH until TLS is on; the TLS port offers AUTH at once", async (t) => {
	const w = await world(t);
	const plain = await connectSmtpPlain(w.ports.starttlsPort);
	t.after(() => plain.end());
	const banner = await plain.reply();
	assert.match(banner.text, /^220 mail\.example\.test ESMTP Mailflare/);
	const before = await plain.cmd("EHLO client.test");
	assert.match(before.text, /250-STARTTLS/);
	assert.doesNotMatch(before.text, /AUTH/);
	assert.doesNotMatch(before.text, /SMTPUTF8/, "internationalised addresses are not accepted");
	assert.match(before.text, /8BITMIME/);
	assert.match(before.text, /SIZE 33750000/, "the outgoing limit plus MIME overhead");
	const early = await plain.authPlain("me@example.test", w.key.fullKey);
	assert.equal(early.code, 538, "AUTH is refused before STARTTLS");
	assert.equal((await plain.cmd("MAIL FROM:<me@example.test>")).code, 530, "and so is mail");
	assert.equal((await plain.cmd("STARTTLS")).code, 220);
	const secure = await upgradeSmtp(plain, ca);
	t.after(() => secure.end());
	assert.equal(["TLSv1.2", "TLSv1.3"].includes(secure.socket.getProtocol()), true);
	const after = await secure.cmd("EHLO client.test");
	assert.match(after.text, /250-AUTH PLAIN LOGIN|250 AUTH PLAIN LOGIN|AUTH LOGIN PLAIN|AUTH PLAIN LOGIN/);
	assert.doesNotMatch(after.text, /STARTTLS/);

	const implicit = await w.implicit();
	t.after(() => implicit.end());
	await implicit.reply();
	const ehlo = await implicit.cmd("EHLO client.test");
	assert.match(ehlo.text, /AUTH PLAIN LOGIN/);
	assert.doesNotMatch(ehlo.text, /STARTTLS/);
});

test("a message submitted after STARTTLS with AUTH PLAIN reaches the provider, the Sent row and the audit log", async (t) => {
	const w = await world(t);
	const client = await w.starttls();
	t.after(() => client.end());
	assert.equal((await client.authPlain("me@example.test", w.key.fullKey)).code, 235);
	const reply = await w.send(client, { recipients: ["a@x.test", "hidden@x.test"], raw: message({ to: "a@x.test" }) });
	assert.equal(reply.code, 250, reply.text);
	assert.match(reply.text, /Queued as msg_/);
	assert.equal(w.sent.length, 1);
	assert.deepEqual([w.sent[0].to, w.sent[0].bcc, w.sent[0].subject], [["a@x.test"], ["hidden@x.test"], "Hello"]);
	assert.equal(Object.keys(w.sent[0].headers ?? {}).some((name) => /bcc/i.test(name)), false);
	const row = w.sqlite.prepare("SELECT status, mailbox_id FROM messages WHERE direction = 'outbound'").get();
	assert.deepEqual({ ...row }, { status: "sent", mailbox_id: "m1" });
	assert.deepEqual(w.sqlite.prepare("SELECT action FROM audit_logs WHERE action LIKE 'email.%' ORDER BY action").all().map((entry) => entry.action), ["email.send", "email.submit"]);
	assert.equal(m.findSubmission("u1", "<c1@mail.local>")?.mailboxId, "m1");
	assert.equal((await client.cmd("QUIT")).code, 221);
});

test("AUTH LOGIN works and a real client library submits on both ports", async (t) => {
	const w = await world(t);
	const client = await w.implicit();
	t.after(() => client.end());
	await client.reply();
	await client.cmd("EHLO client.test");
	assert.equal((await client.cmd("AUTH LOGIN")).code, 334);
	assert.equal((await client.cmd(Buffer.from("me@example.test").toString("base64"))).code, 334);
	assert.equal((await client.cmd(Buffer.from(w.key.fullKey).toString("base64"))).code, 235);

	const opts = { host: "127.0.0.1", auth: { user: "me@example.test", pass: w.key.fullKey }, tls: { ca, servername: "localhost" }, name: "client.test" };
	const tls = nodemailer.createTransport({ ...opts, port: w.ports.tlsPort, secure: true });
	const starttls = nodemailer.createTransport({ ...opts, port: w.ports.starttlsPort, secure: false, requireTLS: true });
	for (const [index, transport] of [tls, starttls].entries()) {
		await transport.sendMail({ from: "me@example.test", to: "Ann <a@x.test>", cc: "b@x.test", bcc: "c@x.test", subject: `via ${index}`, text: "hi", html: "<p>hi</p>", messageId: `<n${index}@mail.local>`, attachments: [{ filename: "a.txt", content: "attached" }] });
	}
	assert.equal(w.sent.length, 2);
	for (const mail of w.sent) {
		assert.deepEqual([mail.to.map((entry) => entry.includes("a@x.test")), mail.cc, mail.bcc], [[true], ["b@x.test"], ["c@x.test"]]);
		assert.equal(mail.attachments[0].filename, "a.txt");
	}
});

test("without AUTH nothing is accepted; a wrong password is 535 with one log line and no secret; the account password and an imap-only key do not work", async (t) => {
	const w = await world(t);
	const client = await w.implicit();
	t.after(() => client.end());
	await client.reply();
	await client.cmd("EHLO client.test");
	assert.equal((await client.cmd("MAIL FROM:<me@example.test>")).code, 530);
	assert.equal((await client.cmd("RCPT TO:<a@x.test>")).code, 530);
	assert.equal((await client.cmd("DATA")).code, 530);
	const wrong = await client.authPlain("me@Example.test\u00e9", "definitely-wrong-secret-value");
	assert.equal(wrong.code, 535);
	assert.deepEqual(w.warnings.filter((line) => line.startsWith("SMTP login failed")), ['SMTP login failed ip=127.0.0.1 reason=bad_secret user="me@Example.test?"']);
	assert.equal(w.warnings.join("\n").includes("definitely-wrong"), false);
	const reading = await w.addKey({ id: "ki", scopes: ["imap"] });
	const other = await w.implicit();
	t.after(() => other.end());
	await other.reply();
	await other.cmd("EHLO client.test");
	assert.equal((await other.authPlain("me@example.test", reading.fullKey)).code, 535);
	assert.equal((await other.authPlain("two@other.test", w.key.fullKey)).code, 535);
	assert.match(w.warnings.at(-1), /reason=no_mailbox user="two@other.test"/);
	assert.equal(w.sent.length, 0);
});

test("an empty or oversized user name or password is refused as malformed without a lookup", async (t) => {
	const w = await world(t, { failureDelayMs: 0 });
	const client = await w.implicit();
	t.after(() => client.end());
	await client.reply();
	await client.cmd("EHLO client.test");
	assert.equal((await client.authPlain("a".repeat(400), w.key.fullKey)).code, 535);
	assert.equal((await client.authPlain("me@example.test", "s".repeat(300))).code, 535);
	assert.deepEqual(w.warnings.filter((line) => line.startsWith("SMTP login")).map((line) => /reason=(\w+)/.exec(line)[1]), ["malformed", "malformed"]);
});

test("a long user name is logged cut to 64 printable characters", async (t) => {
	const w = await world(t);
	const client = await w.implicit();
	t.after(() => client.end());
	await client.reply();
	await client.cmd("EHLO client.test");
	await client.authPlain(`${"é".repeat(100)}@example.test`, "wrong");
	const line = w.warnings.find((entry) => entry.startsWith("SMTP login failed"));
	assert.equal(line, `SMTP login failed ip=127.0.0.1 reason=bad_secret user="${"?".repeat(64)}"`);
});

test("guesses are throttled with a temporary 421 that ends the connection, and the budget is the shared per-address one", async (t) => {
	const w = await world(t);
	let last;
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const client = await w.implicit();
		await client.reply();
		await client.cmd("EHLO client.test");
		last = await client.authPlain("me@example.test", `wrong-guess-${attempt}-wrong`);
		if (last.code === 421) {
			await client.closedPromise;
			break;
		}
		assert.equal(last.code, 535);
		client.end();
	}
	assert.equal(last.code, 421);
	assert.match(w.warnings.at(-1), /reason=throttled/);
});

test("three failed logins on one connection end it", async (t) => {
	const w = await world(t);
	const client = await w.implicit();
	await client.reply();
	await client.cmd("EHLO client.test");
	assert.equal((await client.authPlain("me@example.test", "wrong-1")).code, 535);
	assert.equal((await client.authPlain("me@example.test", "wrong-2")).code, 535);
	assert.equal((await client.authPlain("me@example.test", "wrong-3")).code, 421);
	await client.closedPromise;
});

test("the envelope sender must be an address the login may send as: refused at MAIL FROM", async (t) => {
	const w = await world(t);
	const client = await w.session();
	t.after(() => client.end());
	for (const sender of ["two@other.test", "stranger@elsewhere.test", "team@other.test"]) {
		const reply = await client.cmd(`MAIL FROM:<${sender}>`);
		assert.equal(reply.code, 550, sender);
		assert.match(reply.text, /not allowed/);
	}
	assert.equal((await client.cmd("MAIL FROM:<>")).code, 550, "no null sender");
	assert.equal((await client.cmd("MAIL FROM:<alias@example.test>")).code, 250);
});

test("a From header the login may not send as is refused after DATA, the same way, and nothing is sent", async (t) => {
	const w = await world(t);
	const client = await w.session();
	t.after(() => client.end());
	const reply = await w.send(client, { raw: message({ from: "ceo@example.test" }) });
	assert.equal(reply.code, 550);
	assert.equal(w.sent.length, 0);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
	assert.equal((await w.send(client)).code, 250, "the session is still usable");
});

test("recipients: at most 50, only valid addresses", async (t) => {
	const w = await world(t);
	const client = await w.session();
	t.after(() => client.end());
	assert.equal((await client.cmd("MAIL FROM:<me@example.test>")).code, 250);
	for (let index = 0; index < 50; index += 1) assert.equal((await client.cmd(`RCPT TO:<r${index}@x.test>`)).code, 250);
	assert.equal((await client.cmd("RCPT TO:<r50@x.test>")).code, 452);
	assert.equal((await client.cmd("RSET")).code, 250);
	await client.cmd("MAIL FROM:<me@example.test>");
	assert.equal((await client.cmd("RCPT TO:<not-an-address>")).code >= 500, true);
	assert.equal((await client.cmd("RCPT TO:<a@b>")).code, 553);
});

test("the size limit is advertised and enforced before and while the data is read; nothing is kept past it", async (t) => {
	const w = await world(t, { maxSize: 4000 });
	const client = await w.session();
	t.after(() => client.end());
	assert.match((await client.cmd("EHLO client.test")).text, /SIZE 4000/);
	const declared = await client.cmd("MAIL FROM:<me@example.test> SIZE=5000");
	assert.equal(declared.code, 552);
	assert.equal((await client.cmd("MAIL FROM:<me@example.test>")).code, 250);
	await client.cmd("RCPT TO:<a@x.test>");
	assert.equal((await client.cmd("DATA")).code, 354);
	const reply = await client.data(message({ body: "x".repeat(200).concat("\r\n").repeat(40) }));
	assert.equal(reply.code, 552);
	assert.equal(w.sent.length, 0);
	assert.equal(w.server.dataBytesInFlight, 0, "the memory the message held was given back");
	assert.equal((await w.send(client)).code, 250, "a message inside the limit still goes");
});

test("the in-flight data budget refuses a message that would pass it with a temporary error", async (t) => {
	const w = await world(t, { dataBudget: 3000, maxSize: 100_000 });
	const client = await w.session();
	t.after(() => client.end());
	const reply = await w.send(client, { raw: message({ body: "y".repeat(400).concat("\r\n").repeat(10) }) });
	assert.equal(reply.code, 452);
	assert.equal(w.server.dataBytesInFlight, 0);
	assert.equal(w.sent.length, 0);
});

/** Resolves once `check()` is true, looking again on each turn of the event loop (no time limit of its own; the test runner's applies). */
async function until(check) {
	while (!check()) await new Promise((resolve) => setImmediate(resolve));
}

test("a connection dropped in the middle of DATA gives its share of the data budget back", async (t) => {
	const w = await world(t, { dataBudget: 3000, maxSize: 100_000 });
	const abort = async () => {
		const client = await w.session();
		assert.equal((await client.cmd("MAIL FROM:<me@example.test>")).code, 250);
		assert.equal((await client.cmd("RCPT TO:<a@x.test>")).code, 250);
		assert.equal((await client.cmd("DATA")).code, 354);
		client.write(`Subject: cut off\r\n\r\n${"z".repeat(1000)}\r\n`);
		await until(() => w.server.dataBytesInFlight > 0);
		client.end();
		await until(() => w.server.connectionCount === 0);
		// The raw socket and the TLS socket close in either order; give the other one a few turns of the event loop.
		let turns = 0;
		await until(() => w.server.dataBytesInFlight === 0 || (turns += 1) > 100);
	};
	await abort();
	assert.equal(w.server.dataBytesInFlight, 0, "the charge of the dropped message was released");
	for (let index = 0; index < 9; index += 1) await abort();
	assert.equal(w.server.dataBytesInFlight, 0);
	const client = await w.session();
	t.after(() => client.end());
	assert.equal((await w.send(client)).code, 250, "after ten dropped messages a normal one is still accepted");
});

test("defaults: a failed login waits one second before the answer, and a connection has 30 seconds to log in", async (t) => {
	const delays = [];
	const realSetTimeout = globalThis.setTimeout;
	// Records each delay asked for and runs the one-second one at once, so nothing here depends on the clock.
	t.mock.method(globalThis, "setTimeout", (callback, ms, ...rest) => {
		delays.push(ms);
		return realSetTimeout(callback, ms === 1000 ? 0 : ms, ...rest);
	});
	const w = await world(t, { failureDelayMs: undefined });
	const client = await w.implicit();
	t.after(() => client.end());
	await client.reply();
	assert.equal(delays.includes(30_000), true, `login deadline; delays seen: ${delays}`);
	assert.equal(delays.includes(60_000), false);
	await client.cmd("EHLO client.test");
	assert.equal(delays.includes(1000), false);
	assert.equal((await client.authPlain("me@example.test", "definitely-wrong-secret-value")).code, 535);
	assert.equal(delays.includes(1000), true, `failed-login delay; delays seen: ${delays}`);
});

test("no reverse lookup of the client address is made; EHLO greets the bare address", async (t) => {
	const dns = (await import("node:dns")).default;
	const lookups = t.mock.method(dns, "reverse", (_address, callback) => callback(null, ["ptr.example.test"]));
	const w = await world(t);
	const client = await w.implicit();
	t.after(() => client.end());
	await client.reply();
	const ehlo = await client.cmd("EHLO client.test");
	assert.equal(lookups.mock.callCount(), 0);
	assert.doesNotMatch(ehlo.text, /ptr\.example\.test/);
	assert.match(ehlo.text, /\[127\.0\.0\.1\]/);
});

test("dot-stuffing is undone, and a bare line feed followed by a dot does not end the message", async (t) => {
	const w = await world(t);
	const client = await w.session();
	t.after(() => client.end());
	const body = "first\r\n.starts with a dot\r\nsecond\n.\nthird after a bare dot line\r\nfourth";
	const reply = await w.send(client, { raw: message({ body }) });
	assert.equal(reply.code, 250, reply.text);
	assert.equal(w.sent.length, 1, "one message, not two");
	assert.match(w.sent[0].text, /\.starts with a dot/);
	assert.match(w.sent[0].text, /third after a bare dot line/);
	assert.match(w.sent[0].text, /fourth/);
});

test("very long lines in the body are fine; a command line over the limit is not", async (t) => {
	const w = await world(t);
	const client = await w.session();
	const reply = await w.send(client, { raw: message({ body: `${"w".repeat(5000)}\r\nend` }) });
	assert.equal(reply.code, 250);
	assert.match(w.sent[0].text, /w{5000}/);
	client.write(`NOOP ${"a".repeat(6000)}`);
	const refused = await client.reply();
	assert.equal(refused.code, 421, "a line that never ends is cut off at the limit instead of being buffered");
	await client.closedPromise;
});

test("hourly limits: the cap is checked at MAIL FROM with a temporary error, per user", async (t) => {
	const w = await world(t, { maxPerHour: 2 });
	const client = await w.session();
	t.after(() => client.end());
	assert.equal((await w.send(client, { raw: message({ id: "<h1@x>" }) })).code, 250);
	assert.equal((await w.send(client, { raw: message({ id: "<h2@x>" }) })).code, 250);
	const third = await client.cmd("MAIL FROM:<me@example.test>");
	assert.equal(third.code, 450);
	assert.match(third.text, /limit/i);
	assert.equal(w.sent.length, 2);
});

test("a revoked key stops the session at once: deleted, scope removed or user disabled, before the next message and before the one being sent", async (t) => {
	const w = await world(t);
	const client = await w.session();
	assert.equal((await w.send(client)).code, 250);
	w.sqlite.prepare("DELETE FROM api_keys WHERE id = 'ks'").run();
	const refused = await client.cmd("MAIL FROM:<me@example.test>");
	assert.equal(refused.code, 421);
	await client.closedPromise;

	const key2 = await w.addKey({ id: "k2", scopes: ["submission"] });
	const second = await w.session("me@example.test", key2.fullKey);
	await second.cmd("MAIL FROM:<me@example.test>");
	await second.cmd("RCPT TO:<a@x.test>");
	assert.equal((await second.cmd("DATA")).code, 354);
	w.sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	const last = await second.data(message({ id: "<r@x>" }));
	assert.equal(last.code, 421, "disabled while the data was being sent");
	assert.equal(w.sent.length, 1, "only the first message ever left");
	await second.closedPromise;

	w.sqlite.prepare("UPDATE users SET disabled = 0 WHERE id = 'u1'").run();
	const key3 = await w.addKey({ id: "k3", scopes: ["submission"] });
	const third = await w.session("me@example.test", key3.fullKey);
	w.sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'k3'").run(JSON.stringify(["imap"]));
	assert.equal((await third.cmd("MAIL FROM:<me@example.test>")).code, 421);
});

test("an idle open session is dropped within the revalidation interval after its key is deleted", async (t) => {
	const w = await world(t, { revalidateMs: 50 });
	const client = await w.session();
	w.sqlite.prepare("DELETE FROM api_keys WHERE id = 'ks'").run();
	await client.closedPromise;
});

test("plaintext typed before STARTTLS completes is thrown away, not run inside the tunnel", async (t) => {
	const w = await world(t);
	const plain = await connectSmtpPlain(w.ports.starttlsPort);
	await plain.reply();
	await plain.cmd("EHLO client.test");
	const plainAuth = Buffer.from(`\0me@example.test\0${w.key.fullKey}`).toString("base64");
	plain.write(`STARTTLS\r\nAUTH PLAIN ${plainAuth}\r\nMAIL FROM:<me@example.test>\r\nNOOP`);
	await plain.reply();
	const secure = await upgradeSmtp(plain, ca);
	t.after(() => secure.end());
	const ehlo = await secure.cmd("EHLO client.test");
	assert.equal(ehlo.code, 250);
	const mail = await secure.cmd("MAIL FROM:<me@example.test>");
	assert.equal(mail.code, 530, "the AUTH that arrived in plaintext was not applied");
	assert.equal(w.sent.length, 0);
});

test("a login made before STARTTLS state is forgotten when TLS starts (plain test mode only)", async (t) => {
	const w = await world(t, { allowPlaintext: true });
	const plain = await connectSmtpPlain(w.ports.starttlsPort);
	t.after(() => plain.end());
	await plain.reply();
	await plain.cmd("EHLO client.test");
	assert.equal((await plain.authPlain("me@example.test", w.key.fullKey)).code, 235, "loopback test mode allows AUTH in plaintext");
	assert.equal((await plain.cmd("STARTTLS")).code, 220);
	const secure = await upgradeSmtp(plain, ca);
	t.after(() => secure.end());
	await secure.cmd("EHLO client.test");
	assert.equal((await secure.cmd("MAIL FROM:<me@example.test>")).code, 530);
});

test("plaintext AUTH is refused unless the test flag is set and the bind is loopback", async (t) => {
	const warn = t.mock.method(console, "warn", () => undefined);
	const w = await world(t, { allowPlaintext: true, host: undefined });
	assert.equal(w.server.allowPlaintext, false, "every interface: the flag is ignored");
	assert.match(warn.mock.calls.map((call) => call.arguments.join(" ")).join("\n"), /SUBMISSION_ALLOW_PLAINTEXT is ignored/);
	const plain = await connectSmtpPlain(w.ports.starttlsPort);
	t.after(() => plain.end());
	await plain.reply();
	await plain.cmd("EHLO client.test");
	assert.equal((await plain.authPlain("me@example.test", w.key.fullKey)).code, 538);
});

test("pre-auth abuse: too many commands without logging in ends the connection; silence is cut off", async (t) => {
	const w = await world(t, { authTimeoutMs: 300 });
	const noisy = await w.implicit();
	await noisy.reply();
	let code = 0;
	for (let index = 0; index < 20 && code !== 421; index += 1) code = (await noisy.cmd("NOOP")).code;
	assert.equal(code, 421);
	await noisy.closedPromise;
	const silent = await w.implicit();
	await silent.reply();
	await silent.closedPromise;
	const slowAuth = await w.implicit();
	await slowAuth.reply();
	await slowAuth.cmd("EHLO client.test");
	await slowAuth.closedPromise;
});

test("an authenticated session is not cut off by the login deadline", async (t) => {
	const w = await world(t, { authTimeoutMs: 200 });
	const client = await w.session();
	t.after(() => client.end());
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal((await client.cmd("NOOP")).code, 250);
});

test("connections are counted per address (IPv6 by /64) and for the process, from the first byte, and released on close", async (t) => {
	const w = await world(t, { maxPerIp: 2, maxConnections: 3 });
	const open = async () => {
		const client = await w.implicit();
		return client;
	};
	const first = await open();
	const second = await open();
	assert.equal((await first.reply()).code, 220);
	const third = await connectSmtpTls(w.ports.tlsPort, ca).then(
		(client) => client,
		() => null,
	);
	if (third) await third.closedPromise;
	assert.equal(third === null || third.buffer === "", true, "the third connection from this address gets no greeting");
	first.end();
	await first.closedPromise;
	await new Promise((resolve) => setTimeout(resolve, 50));
	const fourth = await open();
	assert.equal((await fourth.reply()).code, 220, "a closed connection frees its place");
	second.end();
	fourth.end();
});

test("a client that sends commands and never reads the answers is cut off when its output backlog passes the limit", async (t) => {
	const w = await world(t, { maxPendingOutput: 4096, outputCheckMs: 20 });
	const client = await w.session();
	client.socket.pause();
	const chunk = "NOOP\r\n".repeat(20_000);
	let wrote = 0;
	const flood = new Promise((resolve) => {
		const pump = () => {
			while (!client.closed && wrote < 400) {
				wrote += 1;
				if (!client.socket.write(chunk)) return void client.socket.once("drain", pump);
			}
			resolve();
		};
		pump();
	});
	await Promise.race([client.closedPromise, flood.then(() => new Promise((resolve) => setTimeout(resolve, 3000)))]);
	assert.equal(client.closed || client.socket.destroyed, true, "the server dropped the connection");
});

test("the output guard drops a socket whose unsent backlog is over the limit, and stops watching when it closes", async () => {
	const socket = { writableLength: 0, destroyed: false, destroy() { this.destroyed = true; this.closeHandler?.(); }, once(event, handler) { if (event === "close") this.closeHandler = handler; } };
	const stop = m.watchOutput(socket, 100, 5);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(socket.destroyed, false);
	socket.writableLength = 101;
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(socket.destroyed, true);
	stop();
});

test("a renewed certificate is used for new connections without a restart", async (t) => {
	const w = await world(t);
	const otherKey = join(directory, "key2.pem");
	const otherCert = join(directory, "cert2.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", otherKey, "-out", otherCert, "-days", "2", "-subj", "/CN=renewed", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
	const renewed = { key: readFileSync(otherKey), cert: readFileSync(otherCert) };
	const fingerprint = (client) => client.socket.getPeerCertificate().fingerprint256;
	const before = await w.implicit();
	const beforeStarttls = await connectSmtpPlain(w.ports.starttlsPort);
	await beforeStarttls.reply();
	await beforeStarttls.cmd("STARTTLS");
	const first = fingerprint(before);
	before.end();
	beforeStarttls.end();
	w.server.reloadCertificate(renewed);
	const caBoth = Buffer.concat([certificate.cert, renewed.cert]);
	const after = await connectSmtpTls(w.ports.tlsPort, caBoth).catch((error) => { throw new Error(`implicit: ${error.message}`); });
	t.after(() => after.end());
	assert.notEqual(fingerprint(after), first);
	const plain = await connectSmtpPlain(w.ports.starttlsPort);
	await plain.reply();
	await plain.cmd("EHLO client.test");
	await plain.cmd("STARTTLS");
	const upgraded = await upgradeSmtp(plain, caBoth).catch((error) => { throw new Error(`starttls: ${error.message}`); });
	t.after(() => upgraded.end());
	assert.notEqual(fingerprint(upgraded), first);
});

test("the listener refuses to start without a certificate unless it is the loopback test mode on the STARTTLS port", async () => {
	const base = { env: {}, hostname: "h", host: "127.0.0.1", certificate: null };
	await assert.rejects(new m.SubmissionServer({ ...base, tlsPort: 0, starttlsPort: null }).start(), /certificate/);
	await assert.rejects(new m.SubmissionServer({ ...base, tlsPort: null, starttlsPort: 0 }).start(), /certificate/);
	const ok = new m.SubmissionServer({ ...base, tlsPort: null, starttlsPort: 0, allowPlaintext: true });
	const ports = await ok.start();
	assert.equal(typeof ports.starttlsPort, "number");
	await ok.stop();
});

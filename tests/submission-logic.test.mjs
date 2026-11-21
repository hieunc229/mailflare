import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeHelpers, seedWorld } from "./helpers/imap-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-submission-logic-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { authenticateImap, authenticateSubmission, revalidateIdentity, clearLoginAuditMemory } from "./src/lib/imap/auth.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { openRateLimiter } from "./server/runtime/misc.ts";
			export { openFileBucket } from "./server/runtime/file-bucket.ts";
			export { submitMessage, authorizeMailFrom, normalizeAddress, submissionSizeLimit, SubmissionLimiter, SubmissionError, MAX_BODY_BYTES } from "./src/lib/imap/submission.ts";
			export { findSubmission, clearSubmissionMemory } from "./src/lib/imap/sent-dedupe.ts";
			export { getAuthorizedSenderAddress } from "./src/lib/email/sender.ts";
		`,
		resolveDir: root,
		sourcefile: "submission-logic-test-entry.ts",
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

async function world(t, extraEnv = {}) {
	m.clearApiKeyVerificationCache();
	m.clearLoginAuditMemory();
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	seedWorld(database.db);
	return { sqlite: database.db, env: { DB: database, ...extraEnv }, ...makeHelpers(database.db, m.generateAppPassword) };
}
const login = (env, key, username, ip = "203.0.113.5") => m.authenticateSubmission(env, { username, secret: key.fullKey, ip, client: "SMTP" });

test("a submission login needs an app password with the submission scope; an imap-only key does not work here and the reverse", async (t) => {
	const { env, addKey } = await world(t);
	const sending = await addKey({ id: "ks", scopes: ["submission"] });
	const reading = await addKey({ id: "ki", scopes: ["imap"] });
	const both = await addKey({ id: "kb", scopes: ["imap", "submission"] });
	assert.equal((await login(env, sending, "me@example.test")).ok, true);
	assert.deepEqual(await login(env, reading, "me@example.test"), { ok: false, reason: "bad_secret" });
	assert.equal((await login(env, both, "me@example.test")).ok, true);
	assert.deepEqual(await m.authenticateImap(env, { username: "me@example.test", secret: sending.fullKey, ip: null, client: "x" }), { ok: false, reason: "bad_secret" });
});

test("the username names a mailbox the user can access inside the key's scope, and every other case ends the same way", async (t) => {
	const { env, addKey } = await world(t);
	const key = await addKey({ id: "ks", scopes: ["submission"], mailboxes: ["m1b"] });
	assert.equal((await login(env, key, "SECOND@example.test")).identity.loginMailboxId, "m1b");
	for (const name of ["me@example.test", "team@other.test", "two@other.test", "", `${"a".repeat(400)}@example.test`]) assert.deepEqual(await login(env, key, name), { ok: false, reason: "no_mailbox" }, name);
});

test("guesses over submission and IMAP spend the same per-address budget", async (t) => {
	const { env, addKey } = await world(t, { DEVICE_LOGIN_RATE_LIMIT: m.openRateLimiter(10, 60) });
	const key = await addKey({ id: "ks", scopes: ["submission", "imap"] });
	const reasons = [];
	for (let attempt = 0; attempt < 6; attempt += 1) reasons.push((await m.authenticateImap(env, { username: "me@example.test", secret: `wrong-imap-guess-${attempt}`, ip: "203.0.113.9", client: "x" })).reason);
	for (let attempt = 0; attempt < 6; attempt += 1) reasons.push((await m.authenticateSubmission(env, { username: "me@example.test", secret: `wrong-smtp-guess-${attempt}`, ip: "203.0.113.9", client: "SMTP" })).reason);
	assert.deepEqual(reasons, [...Array(10).fill("bad_secret"), "throttled", "throttled"]);
	assert.equal((await login(env, key, "me@example.test", "203.0.113.9")).reason, "throttled");
	assert.equal((await login(env, key, "me@example.test", "203.0.113.77")).ok, true);
});

test("a submission login is audited as an SMTP login with the key id and no secret", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "ks", scopes: ["submission"] });
	await login(env, key, "me@example.test");
	const [row] = sqlite.prepare("SELECT action, metadata FROM audit_logs").all();
	assert.equal(row.action, "auth.app_password_login");
	assert.deepEqual(JSON.parse(row.metadata), { ipAddress: "203.0.113.5", device: "Mail app", platform: "SMTP", keyId: "ks" });
	assert.equal(row.metadata.includes(key.fullKey), false);
});

test("a submission session's login stands until the key is deleted, loses the submission scope, or its user is disabled", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "ks", scopes: ["submission"] });
	const { identity } = await login(env, key, "me@example.test");
	assert.equal((await m.revalidateIdentity(env, identity, "submission"))?.keyId, "ks");
	assert.equal(await m.revalidateIdentity(env, identity), null, "the default protocol is imap, which this key does not carry");
	sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'ks'").run(JSON.stringify(["imap"]));
	assert.equal(await m.revalidateIdentity(env, identity, "submission"), null, "scope removed");
	sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'ks'").run(JSON.stringify(["submission"]));
	sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	assert.equal(await m.revalidateIdentity(env, identity, "submission"), null, "user disabled");
	sqlite.prepare("UPDATE users SET disabled = 0 WHERE id = 'u1'").run();
	sqlite.prepare("DELETE FROM api_keys WHERE id = 'ks'").run();
	assert.equal(await m.revalidateIdentity(env, identity, "submission"), null, "key deleted");
});

// ---- accepting a message ----

const CRLF = (lines) => lines.join("\r\n");
function mail({ from = "me@example.test", to = "a@x.test", cc, subject = "Hello", messageId = "<client-1@mail.local>", extra = [], body = ["", "plain body", ""] } = {}) {
	return Buffer.from(CRLF([`From: ${from}`, `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${subject}`, `Message-ID: ${messageId}`, "Date: Mon, 1 Jan 2024 10:00:00 +0000", ...extra, ...body]));
}

async function sendWorld(t, options = {}) {
	m.clearSubmissionMemory();
	const w = await world(t, { BUCKET: m.openFileBucket(mkdtempSync(join(directory, "blobs-"))), MAILFLARE_RUNTIME: "node", APP_URL: "https://mail.example.test", ...options });
	w.sqlite.prepare("UPDATE domains SET sending_provider = 'cloudflare'").run();
	w.sent = [];
	w.env.EMAIL = {
		send: async (message) => {
			w.sent.push(message);
			if (w.fail) throw typeof w.fail === "string" ? new Error(w.fail) : w.fail;
			w.afterSend?.();
			return { messageId: `<cf-${w.sent.length}@example.test>` };
		},
	};
	const key = await w.addKey({ id: "ks", scopes: ["submission"], ...(options.keyOptions ?? {}) });
	w.login = async (username = "me@example.test") => {
		const result = await login(w.env, key, username);
		assert.equal(result.ok, true);
		return result.identity;
	};
	w.limiter = new m.SubmissionLimiter(200, 1000);
	w.submit = async (raw, { identity, mailFrom = "me@example.test", recipients = ["a@x.test"], limiter = w.limiter } = {}) => m.submitMessage(w.env, identity ?? (await w.login()), { mailFrom, recipients, raw, ip: "203.0.113.5" }, limiter);
	w.rejects = async (promise, code, pattern) => {
		await assert.rejects(promise, (error) => {
			assert.equal(error instanceof m.SubmissionError, true, `${error?.stack ?? error}`);
			assert.equal(error.responseCode, code, error.message);
			if (pattern) assert.match(error.message, pattern);
			return true;
		});
		assert.equal(w.sent.length, 0, "nothing was handed to the provider");
	};
	return w;
}

test("a message goes through sendEmail: Sent row, provider call, Bcc from the envelope, two audit entries, dedupe memory", async (t) => {
	const w = await sendWorld(t);
	const { messageId } = await w.submit(mail({ to: '"Ann A" <a@x.test>', cc: "b@x.test", extra: ["In-Reply-To: <parent@x.test>", "References: <root@x.test> <parent@x.test>"] }), { recipients: ["a@x.test", "b@x.test", "C@X.test"] });
	assert.equal(w.sent.length, 1);
	const call = w.sent[0];
	assert.match(call.from, /me@example\.test/, "the provider sees the authorised sender");
	assert.deepEqual(call.to, ['"Ann A" <a@x.test>']);
	assert.deepEqual(call.cc, ["b@x.test"]);
	assert.deepEqual(call.bcc, ["c@x.test"], "an envelope recipient the headers do not list is a Bcc");
	assert.equal(call.subject, "Hello");
	assert.equal(call.text.trim(), "plain body");
	assert.equal(call.headers["In-Reply-To"], "<parent@x.test>");
	assert.equal(call.headers.References, "<root@x.test> <parent@x.test>");
	assert.equal(Object.keys(call.headers).some((name) => /^bcc$/i.test(name)), false, "no Bcc header is ever sent");
	assert.equal(call.headers.Sender, undefined, "the owner sends as themselves");
	const row = w.sqlite.prepare("SELECT status, mailbox_id, user_id, direction, bcc_addr, subject FROM messages WHERE id = ?").get(messageId);
	assert.deepEqual({ ...row }, { status: "sent", mailbox_id: "m1", user_id: "u1", direction: "outbound", bcc_addr: "c@x.test", subject: "Hello" });
	const audits = w.sqlite.prepare("SELECT action, mailbox_id, message_id, metadata FROM audit_logs WHERE action IN ('email.send', 'email.submit') ORDER BY action").all();
	assert.deepEqual(audits.map((entry) => entry.action), ["email.send", "email.submit"]);
	assert.deepEqual(JSON.parse(audits[1].metadata), { keyId: "ks", ip: "203.0.113.5" });
	assert.equal(audits[1].message_id, messageId);
	assert.deepEqual(m.findSubmission("u1", "<client-1@mail.local>"), { messageId, mailboxId: "m1" }, "a later APPEND of the same message to Sent is recognised");
});

test("an alias, and the second personal mailbox, are addresses the login may send as; the envelope sender must belong to the same mailbox", async (t) => {
	const w = await sendWorld(t);
	await w.submit(mail({ from: "Alias <alias@example.test>" }), { mailFrom: "me@example.test" });
	await w.submit(mail({ from: "second@example.test", messageId: "<c2@x>" }), { mailFrom: "SECOND@example.test" });
	assert.deepEqual(w.sqlite.prepare("SELECT mailbox_id FROM messages ORDER BY created_at, rowid").all().map((row) => row.mailbox_id), ["m1", "m1b"]);
	await assert.rejects(w.submit(mail({ from: "second@example.test" }), { mailFrom: "me@example.test" }), (error) => error.responseCode === 550);
	assert.equal(w.sent.length, 2);
});

test("a From the login may not send as is refused before the provider: another user's address, an unknown domain, a read-only delegation, an address outside the key's mailbox scope", async (t) => {
	const w = await sendWorld(t);
	await w.rejects(w.submit(mail({ from: "two@other.test" }), { mailFrom: "two@other.test" }), 550);
	await w.rejects(w.submit(mail({ from: "me@elsewhere.test" }), { mailFrom: "me@elsewhere.test" }), 550);
	await w.rejects(w.submit(mail({ from: "team@other.test" }), { mailFrom: "team@other.test" }), 550, /not allowed/i);
	await w.rejects(m.authorizeMailFrom(w.env, await w.login(), "team@other.test"), 550);
	await w.rejects(m.authorizeMailFrom(w.env, await w.login(), ""), 550, /sender/i);
	const scoped = await sendWorld(t, { keyOptions: { mailboxes: ["m1b"] } });
	await scoped.rejects(scoped.submit(mail(), { identity: await scoped.login("second@example.test") }), 550);
	assert.equal((await scoped.submit(mail({ from: "second@example.test" }), { identity: await scoped.login("second@example.test"), mailFrom: "second@example.test" })).messageId.length > 0, true);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 0, "refused mail leaves no Sent row");
});

test("delegates send under the rules of the web composer: send_as under the shared address, send_on_behalf under the web path's display name and no Sender header, read_only never", async (t) => {
	const w = await sendWorld(t);
	const identity = await w.login("team@other.test");
	const go = () => w.submit(mail({ from: "team@other.test", messageId: `<d${w.sent.length}@x>` }), { mailFrom: "team@other.test", identity });
	await w.rejects(go(), 550);
	w.sqlite.prepare("UPDATE mailbox_access SET permission = 'send_as' WHERE id = 'ma1'").run();
	await go();
	assert.match(w.sent[0].from, /team@other\.test/);
	assert.doesNotMatch(w.sent[0].from, /on behalf/i);
	assert.equal(w.sent[0].headers?.Sender, undefined);
	w.sqlite.prepare("UPDATE mailbox_access SET permission = 'send_on_behalf' WHERE id = 'ma1'").run();
	await go();
	assert.match(w.sent[1].from, /on behalf of/i);
	const web = await m.getAuthorizedSenderAddress(w.env, { userId: "u1", from: "team@other.test", mailboxId: "ms" });
	assert.equal(w.sent[1].from, web.fromAddr, "the same From the web composer sends on someone's behalf");
	assert.equal(w.sent[1].headers?.Sender, undefined, "no Sender header naming the account's own address");
	assert.equal(w.sqlite.prepare("SELECT mailbox_id FROM messages WHERE user_id = 'u1' ORDER BY rowid DESC LIMIT 1").get().mailbox_id, "ms");
});

test("recipients: header recipients nobody RCPT'd are dropped, a message without any To is refused, duplicates collapse, over 50 is refused", async (t) => {
	const w = await sendWorld(t);
	await w.submit(mail({ to: "a@x.test, ghost@x.test", cc: "A@x.test, b@x.test" }), { recipients: ["a@x.test", "b@x.test"] });
	assert.deepEqual([w.sent[0].to, w.sent[0].cc, w.sent[0].bcc ?? []], [["a@x.test"], ["b@x.test"], []]);
	await assert.rejects(w.submit(mail({ to: "ghost@x.test", messageId: "<n1@x>" }), { recipients: ["a@x.test"] }), (error) => error.responseCode === 554 && /To/.test(error.message));
	await assert.rejects(w.submit(mail({ to: "a@x.test", messageId: "<n2@x>" }), { recipients: [] }), (error) => error.responseCode === 554);
	const many = Array.from({ length: 51 }, (_, index) => `r${index}@x.test`);
	await assert.rejects(w.submit(mail({ to: many.join(", "), messageId: "<n3@x>" }), { recipients: many }), (error) => error.responseCode === 554 && /50/.test(error.message));
	assert.equal(w.sent.length, 1);
});

test("signed and encrypted mail is refused with a clear error, because re-composing it would break the signature", async (t) => {
	const w = await sendWorld(t);
	for (const type of ['multipart/signed; protocol="application/pkcs7-signature"; boundary=B', "application/pkcs7-mime; smime-type=enveloped-data", "application/x-pkcs7-mime", 'multipart/encrypted; protocol="application/pgp-encrypted"; boundary=B', "MULTIPART/Signed; boundary=B"]) {
		await w.rejects(w.submit(mail({ extra: [`Content-Type: ${type}`] })), 554, /signed or encrypted/i);
	}
});

test("one From only: a second From header or several addresses in it is refused", async (t) => {
	const w = await sendWorld(t);
	await w.rejects(w.submit(mail({ extra: ["From: second@example.test"] })), 550);
	await w.rejects(w.submit(mail({ from: "me@example.test, second@example.test" })), 550);
	await w.rejects(w.submit(Buffer.from("To: a@x.test\r\nSubject: x\r\n\r\nbody\r\n")), 550, /from/i);
});

test("header values from the client cannot break a header: encoded line breaks in the subject and in display names are flattened", async (t) => {
	const w = await sendWorld(t);
	await w.submit(mail({ subject: "=?utf-8?q?hello=0D=0ABcc:_evil@x.test?=", to: '"=?utf-8?q?Ann=0D=0AX-Evil:_1?=" <a@x.test>', extra: ["References: <a@x> <b@x>\r\n\tcc: evil@x.test"] }));
	const call = w.sent[0];
	const strings = [call.from, call.subject, ...call.to, ...(call.cc ?? []), ...(call.bcc ?? []), ...Object.entries(call.headers ?? {}).flat()];
	for (const value of strings) assert.doesNotMatch(value, /[\r\n\0]/, value);
	assert.equal(call.subject, "hello Bcc: evil@x.test");
});

test("the limits of the web composer apply: subject over 500, a text body over 2 MiB, no body at all", async (t) => {
	const w = await sendWorld(t);
	await w.rejects(w.submit(mail({ subject: "s".repeat(501) })), 554, /subject/i);
	await w.rejects(w.submit(mail({ body: ["", "x".repeat(m.MAX_BODY_BYTES + 1), ""], messageId: "<big@x>" })), 554, /too large/i);
	await w.rejects(w.submit(mail({ body: [""], messageId: "<empty@x>" })), 554, /no text/i);
	assert.equal((await w.submit(mail({ subject: "s".repeat(500), messageId: "<ok@x>" }))).messageId.length > 0, true);
});

test("an empty subject is sent as (no subject), like JMAP does", async (t) => {
	const w = await sendWorld(t);
	await w.submit(Buffer.from("From: me@example.test\r\nTo: a@x.test\r\nMessage-ID: <e@x>\r\n\r\nbody\r\n"));
	assert.equal(w.sent[0].subject, "(no subject)");
});

test("attachments and inline images go through; the outgoing size limit of sendEmail is the web composer's", async (t) => {
	const w = await sendWorld(t);
	const raw = Buffer.from(CRLF(["From: me@example.test", "To: a@x.test", "Subject: pic", "Message-ID: <att@x>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="M"', "", "--M", "Content-Type: text/html", "", '<p>hi <img src="cid:logo"></p>', "--M", "Content-Type: image/png", "Content-Transfer-Encoding: base64", "Content-ID: <logo>", "Content-Disposition: inline; filename=logo.png", "", Buffer.from("PNGDATA").toString("base64"), "--M", "Content-Type: application/pdf", "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="doc.pdf"', "", Buffer.from("%PDF-1").toString("base64"), "--M--", ""]));
	await w.submit(raw);
	const attachments = w.sent[0].attachments;
	assert.deepEqual(attachments.map((a) => [a.filename, a.disposition]), [["logo.png", "inline"], ["doc.pdf", "attachment"]]);
	assert.equal(attachments[0].contentId, "logo");
	assert.equal(Buffer.from(attachments[1].content).toString(), "%PDF-1");
	w.sqlite.prepare("INSERT INTO app_settings (id, outbound_attachment_max_mb, updated_at) VALUES ('default', 1, 1) ON CONFLICT(id) DO UPDATE SET outbound_attachment_max_mb = 1").run();
	const big = raw.toString().replace(Buffer.from("%PDF-1").toString("base64"), Buffer.alloc(1_500_000, 1).toString("base64"));
	w.sent.length = 0;
	await w.rejects(w.submit(Buffer.from(big.replace("<att@x>", "<att2@x>"))), 554, /exceed/i);
});

test("the SIZE limit follows the outgoing attachment limit plus MIME overhead, never above 36 MiB", () => {
	assert.equal(m.submissionSizeLimit(25), Math.floor(25_000_000 * 1.35));
	assert.equal(m.submissionSizeLimit(1), 1_350_000);
	assert.equal(m.submissionSizeLimit(500), 36 * 1024 * 1024);
});

test("sending errors map to permanent or temporary answers, and provider details stay out of the reply", async (t) => {
	const w = await sendWorld(t);
	w.fail = "Resend: secret-key-123 rejected";
	await assert.rejects(w.submit(mail()), (error) => error.responseCode === 451 && !/secret|Resend/.test(error.message));
	w.sqlite.prepare("UPDATE domains SET sending_provider = 'none'").run();
	await assert.rejects(w.submit(mail({ messageId: "<n@x>" })), (error) => error.responseCode === 554 && /not set up/i.test(error.message));
	assert.equal(m.findSubmission("u1", "<client-1@mail.local>"), null, "a failed send is not remembered as a Sent copy");
});

test("once the provider has taken the message, a failure in the bookkeeping after it still answers success", async (t) => {
	const w = await sendWorld(t);
	t.mock.method(console, "error", () => undefined);
	// The provider accepts; then marking the job sent fails.
	w.afterSend = () => w.sqlite.exec("CREATE TRIGGER no_sent BEFORE UPDATE ON outbound_jobs WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
	const first = await w.submit(mail());
	assert.equal(typeof first.messageId, "string");
	assert.equal(w.sent.length, 1);
	assert.equal(m.findSubmission("u1", "<client-1@mail.local>")?.messageId, first.messageId, "remembered like any sent message");
	w.sqlite.exec("DROP TRIGGER no_sent");
	// The provider accepts; then every later write fails, the failure bookkeeping included.
	w.afterSend = () => w.sqlite.exec("CREATE TRIGGER no_jobs BEFORE UPDATE ON outbound_jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END; CREATE TRIGGER no_messages BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END");
	const second = await w.submit(mail({ messageId: "<b2@x>" }));
	assert.equal(typeof second.messageId, "string");
	assert.equal(w.sent.length, 2);
});

test("a provider's permanent refusal is a final 554; a busy provider or a network failure is a temporary 451", async (t) => {
	const w = await sendWorld(t, { RESEND_API_KEY: "re_test_key", RESEND_BASE_URL: "http://resend.invalid" });
	w.sqlite.prepare("UPDATE domains SET sending_provider = 'resend'").run();
	t.mock.method(console, "error", () => undefined);
	let answer;
	const calls = t.mock.method(globalThis, "fetch", async () => answer());
	const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	let n = 0;
	const next = () => mail({ messageId: `<r${(n += 1)}@x>` });
	answer = json(422, { message: "secret-detail: The to address is invalid" });
	await assert.rejects(w.submit(next()), (error) => error.responseCode === 554 && !/secret|Resend/.test(error.message));
	answer = json(403, { message: "domain not verified" });
	await assert.rejects(w.submit(next()), (error) => error.responseCode === 554);
	answer = json(503, { message: "unavailable" });
	await assert.rejects(w.submit(next()), (error) => error.responseCode === 451);
	answer = json(429, { message: "slow down" });
	await assert.rejects(w.submit(next()), (error) => error.responseCode === 451);
	answer = () => { throw new TypeError("fetch failed"); };
	await assert.rejects(w.submit(next()), (error) => error.responseCode === 451);
	assert.equal(calls.mock.calls.filter((call) => String(call.arguments[0]) === "http://resend.invalid/emails").length, 5, "every case reached the (stubbed) provider");
	// The Cloudflare send binding names its refusals by code.
	w.sqlite.prepare("UPDATE domains SET sending_provider = 'cloudflare'").run();
	w.fail = Object.assign(new Error("recipient suppressed"), { code: "E_RECIPIENT_SUPPRESSED" });
	await assert.rejects(w.submit(next()), (error) => error.responseCode === 554);
	w.fail = Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" });
	await assert.rejects(w.submit(next()), (error) => error.responseCode === 451);
});

test("the hourly limits are per user, count messages and recipients, and slide", () => {
	const limiter = new m.SubmissionLimiter(3, 5, 1000);
	const t0 = 1_000_000;
	assert.equal(limiter.hasRoom("u1", t0), true);
	assert.equal(limiter.take("u1", 2, t0), true);
	assert.equal(limiter.take("u1", 3, t0 + 10), true);
	assert.equal(limiter.take("u1", 1, t0 + 20), false, "6 recipients is over the 5 an hour");
	assert.equal(limiter.hasRoom("u1", t0 + 20), true, "messages are still under the cap");
	assert.equal(limiter.take("u1", 0, t0 + 20), true);
	assert.equal(limiter.hasRoom("u1", t0 + 30), false, "three messages used");
	assert.equal(limiter.take("u1", 1, t0 + 30), false);
	assert.equal(limiter.take("u2", 5, t0 + 30), true, "another user has their own budget");
	assert.equal(limiter.take("u1", 2, t0 + 1005), true, "the first message slid out of the window");
	assert.equal(limiter.take("u1", 4, t0 + 5000), true, "everything slid out");
});

test("the limiter forgets idle users and never holds more than its bound", () => {
	const limiter = new m.SubmissionLimiter(5, 50, 1000, 100);
	for (let index = 0; index < 250; index += 1) limiter.take(`user${index}`, 1, 1000 + index);
	assert.equal(limiter.size <= 100, true);
	limiter.take("late", 1, 1_000_000);
	assert.equal(limiter.size, 1, "everything older than the window was swept");
});

test("a message over the hourly limit is refused with a temporary error and leaves nothing behind", async (t) => {
	const w = await sendWorld(t);
	const limiter = new m.SubmissionLimiter(1, 100);
	await w.submit(mail(), { limiter });
	await assert.rejects(w.submit(mail({ messageId: "<l2@x>" }), { limiter }), (error) => error.responseCode === 450 && /limit/i.test(error.message));
	assert.equal(w.sent.length, 1);
	assert.equal(w.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
});

test("addresses are checked strictly and domains are punycoded", () => {
	assert.equal(m.normalizeAddress("User.Name+tag@Example.COM"), "user.name+tag@example.com");
	assert.equal(m.normalizeAddress("me@bücher.example"), "me@xn--bcher-kva.example");
	for (const bad of ["", "a", "a@b", "a@b..c", "@x.test", "a b@x.test", "a@x.test\r\nRCPT TO:<z@x.test>", "a@x.test>", "a<b@x.test", '"a"@x.test', "a,b@x.test", "mé@x.test", ".a@x.test", "a.@x.test", "a..b@x.test", `${"a".repeat(65)}@x.test`, `a@${"b".repeat(64)}.test`, "a@-x.test", `a@${"b.".repeat(130)}test`]) assert.equal(m.normalizeAddress(bad), null, JSON.stringify(bad));
});

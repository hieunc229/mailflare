import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-suppression-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		utils: join(root, "src/lib/deliverability/suppression-utils.ts"),
		dsn: join(root, "src/lib/deliverability/dsn.ts"),
		service: join(root, "src/lib/deliverability/suppression.ts"),
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
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const utils = await load("utils");
const { parseDeliveryStatus } = await load("dsn");
const service = await load("service");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const seconds = (date) => Math.floor(date.getTime() / 1000);

// ---- pure helpers -------------------------------------------------------------

test("filterSuppressed splits recipients by bare lower-case address and keeps display names", () => {
	const result = utils.filterSuppressed(["Anna <Anna@Example.org>", "bob@example.org", "bob@example.org "], new Set(["anna@example.org"]));
	assert.deepEqual(result.allowed, ["bob@example.org", "bob@example.org"]);
	assert.deepEqual(result.suppressed, ["anna@example.org"]);
});

test("mapResendEvent: permanent bounce, complaint, display-name sender", () => {
	const bounced = utils.mapResendEvent({ type: "email.bounced", data: { from: "Acme <hi@Example.com>", to: ["A@x.org", "b@x.org"], bounce: { type: "Permanent", subType: "Suppressed", message: "No such user" } } });
	assert.equal(bounced.sender, "hi@example.com");
	assert.deepEqual(bounced.entries.map((entry) => [entry.email, entry.reason]), [["a@x.org", "hard_bounce"], ["b@x.org", "hard_bounce"]]);
	assert.equal(bounced.entries[0].detail, "No such user");
	const complained = utils.mapResendEvent({ type: "email.complained", data: { from: "hi@example.com", to: ["a@x.org"] } });
	assert.deepEqual(complained.entries.map((entry) => entry.reason), ["complaint"]);
});

test("mapResendEvent marks every entry unconfirmed when the event names several recipients (no per-recipient field in the payload)", () => {
	const flags = (event) => event.entries.map((entry) => entry.unconfirmed === true);
	assert.deepEqual(flags(utils.mapResendEvent({ type: "email.bounced", data: { from: "a@example.com", to: ["a@x.org", "b@x.org"], bounce: { type: "Permanent" } } })), [true, true]);
	assert.deepEqual(flags(utils.mapResendEvent({ type: "email.complained", data: { from: "a@example.com", to: ["a@x.org", "b@x.org"] } })), [true, true]);
	assert.deepEqual(flags(utils.mapResendEvent({ type: "email.bounced", data: { from: "a@example.com", to: ["a@x.org"], bounce: { type: "Permanent" } } })), [false]);
	assert.deepEqual(flags(utils.mapResendEvent({ type: "email.complained", data: { from: "a@example.com", to: ["a@x.org", "A@x.org"] } })), [false], "duplicates are one recipient");
});

test("mapResendEvent ignores temporary and transient bounces in any case, records a bounce with no type", () => {
	for (const type of ["Temporary", "Transient", "transient", "TEMPORARY"]) {
		assert.equal(utils.mapResendEvent({ type: "email.bounced", data: { from: "a@example.com", to: ["b@x.org"], bounce: { type } } }), null, type);
	}
	const bare = utils.mapResendEvent({ type: "email.bounced", data: { from: "a@example.com", to: ["b@x.org"] } });
	assert.deepEqual(bare.entries.map((entry) => entry.reason), ["hard_bounce"]);
});

test("mapResendEvent rejects other events and malformed payloads", () => {
	for (const body of [null, "x", {}, { type: "email.delivered", data: { from: "a@example.com", to: ["b@x.org"] } }, { type: "email.bounced" }, { type: "email.bounced", data: { from: "a@example.com", to: "b@x.org" } }, { type: "email.bounced", data: { to: ["b@x.org"] } }, { type: "email.bounced", data: { from: "a@example.com", to: ["not an address", 5] } }]) {
		assert.equal(utils.mapResendEvent(body), null, JSON.stringify(body));
	}
});

test("mapSesNotification: permanent bounce and complaint; transient and undetermined ignored", () => {
	const bounce = utils.mapSesNotification(JSON.stringify({ notificationType: "Bounce", mail: { source: "Me <me@example.com>" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "A@x.org", diagnosticCode: "smtp; 550 5.1.1 user unknown" }] } }));
	assert.equal(bounce.sender, "me@example.com");
	assert.deepEqual(bounce.entries.map((entry) => [entry.email, entry.reason, entry.detail]), [["a@x.org", "hard_bounce", "smtp; 550 5.1.1 user unknown"]]);
	const complaint = utils.mapSesNotification(JSON.stringify({ notificationType: "Complaint", mail: { source: "me@example.com" }, complaint: { complainedRecipients: [{ emailAddress: "c@x.org" }] } }));
	assert.deepEqual(complaint.entries.map((entry) => entry.reason), ["complaint"]);
	for (const bounceType of ["Transient", "Undetermined"]) {
		assert.equal(utils.mapSesNotification(JSON.stringify({ notificationType: "Bounce", mail: { source: "me@example.com" }, bounce: { bounceType, bouncedRecipients: [{ emailAddress: "a@x.org" }] } })), null, bounceType);
	}
	assert.equal(utils.mapSesNotification("not json"), null);
	assert.equal(utils.mapSesNotification(JSON.stringify({ notificationType: "Received" })), null);
});

test("detail is truncated to 300 characters", () => {
	const long = "x".repeat(500);
	const mapped = utils.mapSesNotification(JSON.stringify({ notificationType: "Bounce", mail: { source: "me@example.com" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@x.org", diagnosticCode: long }] } }));
	assert.equal(mapped.entries[0].detail.length, 300);
});

// ---- delivery status notifications ----------------------------------------------

const dsn = ({ action = "failed", status = "5.1.1", original = "Message-ID: <orig-1@mail.example.com>", originalType = "text/rfc822-headers", recipient = "anna@example.org", recipients = [recipient] } = {}) => [
	"From: MAILER-DAEMON@mx.example.org",
	"To: kevin@example.com",
	"Subject: Undelivered Mail Returned to Sender",
	"MIME-Version: 1.0",
	'Content-Type: multipart/report; report-type=delivery-status; boundary="BND"',
	"",
	"--BND",
	"Content-Type: text/plain; charset=us-ascii",
	"",
	"This is the mail system.",
	"",
	"--BND",
	"Content-Type: message/delivery-status",
	"",
	"Reporting-MTA: dns; mx.example.org",
	"",
	...recipients.flatMap((address) => [
		`Final-Recipient: rfc822; ${address}`,
		`Action: ${action}`,
		`Status: ${status}`,
		"Diagnostic-Code: smtp; 550 5.1.1 <anna@example.org>: Recipient address rejected",
		"",
	]),
	"--BND",
	`Content-Type: ${originalType}`,
	"",
	"Received: from x by y",
	original,
	"Subject: Offer",
	"",
	"--BND--",
	"",
].join("\r\n");
const toBuffer = (text) => new TextEncoder().encode(text).buffer;

test("parseDeliveryStatus reads recipients and the original Message-ID", () => {
	const parsed = parseDeliveryStatus(toBuffer(dsn()));
	assert.equal(parsed.originalMessageId, "orig-1@mail.example.com");
	assert.deepEqual(parsed.recipients.map(({ finalRecipient, action, status }) => ({ finalRecipient, action, status })), [{ finalRecipient: "anna@example.org", action: "failed", status: "5.1.1" }]);
	assert.match(parsed.recipients[0].diagnostic, /Recipient address rejected/);
});

test("parseDeliveryStatus reads the Message-ID from an embedded message/rfc822 part", () => {
	const parsed = parseDeliveryStatus(toBuffer(dsn({ originalType: "message/rfc822" })));
	assert.equal(parsed.originalMessageId, "orig-1@mail.example.com");
});

test("parseDeliveryStatus returns null for ordinary mail and unknown report types", () => {
	assert.equal(parseDeliveryStatus(toBuffer("From: a@x.org\r\nContent-Type: text/plain\r\n\r\nhello")), null);
	assert.equal(parseDeliveryStatus(toBuffer(dsn().replace("delivery-status;", "disposition-notification;"))), null);
});

test("parseDeliveryStatus only reads the first 256 KiB", () => {
	const padding = "x".repeat(300 * 1024);
	const late = dsn().replace("This is the mail system.", padding);
	assert.equal(parseDeliveryStatus(toBuffer(late)), null);
});

// ---- database ---------------------------------------------------------------------

async function createFixture(t, mode) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d2', 'u1', 'other.org', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u1', 'd2', 'sales', ?)").run(now);
	if (mode) database.db.prepare("UPDATE app_settings SET suppression_mode = ? WHERE id = 'default'").run(mode);
	const addSent = ({ id = "m1", mailboxId = "mb1", from = "Kevin <kevin@example.com>", to = "Anna <anna@example.org>, bob@example.org", cc = null, providerMessageId = "orig-1@mail.example.com", direction = "outbound", at = new Date() } = {}) => {
		database.db.prepare("INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, cc_addr, subject, status, provider_message_id, created_at) VALUES (?, ?, 'u1', ?, ?, ?, ?, 'Offer', 'sent', ?, ?)").run(id, mailboxId, direction, from, to, cc, providerMessageId, seconds(at));
	};
	const rows = () => database.db.prepare("SELECT domain_id, email, reason, source, event_count, detail, confirmed FROM email_suppressions ORDER BY domain_id, email").all();
	return { env: { DB: database }, raw: database.db, addSent, rows };
}

test("getSuppressionMode defaults to off, with and without a settings row", async (t) => {
	const { env } = await createFixture(t);
	assert.equal(await service.getSuppressionMode(env), "off");
	const withRow = await createFixture(t, "enforce");
	assert.equal(await service.getSuppressionMode(withRow.env), "enforce");
});

test("getSuppressionMode reads off when the migration is not applied", async () => {
	const failing = { DB: { prepare() { throw new Error("no such column: suppression_mode"); } } };
	assert.equal(await service.getSuppressionMode(failing), "off");
});

test("recordSuppressionEvents does nothing in mode off", async (t) => {
	const { env, rows } = await createFixture(t, "off");
	const count = await service.recordSuppressionEvents(env, { sender: "kevin@example.com", source: "resend", entries: [{ email: "anna@example.org", reason: "hard_bounce" }] });
	assert.equal(count, 0);
	assert.deepEqual(rows(), []);
});

test("recordSuppressionEvents stores per sending domain and counts repeats", async (t) => {
	const { env, rows } = await createFixture(t, "record");
	const entry = { email: "anna@example.org", reason: "hard_bounce", detail: "550" };
	assert.equal(await service.recordSuppressionEvents(env, { sender: "kevin@example.com", source: "ses", entries: [entry] }), 1);
	await service.recordSuppressionEvents(env, { sender: "kevin@example.com", source: "ses", entries: [entry] });
	await service.recordSuppressionEvents(env, { sender: "sales@other.org", source: "ses", entries: [entry] });
	assert.deepEqual(rows().map((row) => [row.domain_id, row.email, row.event_count]), [["d1", "anna@example.org", 2], ["d2", "anna@example.org", 1]]);
});

test("recordSuppressionEvents ignores a sender on an unknown domain", async (t) => {
	const { env, rows } = await createFixture(t, "record");
	assert.equal(await service.recordSuppressionEvents(env, { sender: "x@unknown.test", source: "resend", entries: [{ email: "a@x.org", reason: "complaint" }] }), 0);
	assert.deepEqual(rows(), []);
});

test("reason only ever gets stronger: complaint > hard_bounce > manual", async (t) => {
	const { env, rows } = await createFixture(t, "record");
	const base = { domainId: "d1", email: "a@x.org" };
	await service.recordSuppression(env, { ...base, reason: "manual", source: "admin", detail: "note" });
	assert.equal(rows()[0].reason, "manual");
	await service.recordSuppression(env, { ...base, reason: "hard_bounce", source: "ses", detail: "550" });
	assert.deepEqual([rows()[0].reason, rows()[0].source, rows()[0].detail, rows()[0].event_count], ["hard_bounce", "ses", "550", 2]);
	await service.recordSuppression(env, { ...base, reason: "complaint", source: "resend" });
	assert.equal(rows()[0].reason, "complaint");
	await service.recordSuppression(env, { ...base, reason: "hard_bounce", source: "ses", detail: "again" });
	await service.recordSuppression(env, { ...base, reason: "manual", source: "admin", detail: "again" });
	const row = rows()[0];
	assert.deepEqual([row.reason, row.source, row.event_count], ["complaint", "resend", 4]);
});

test("findSuppressed is scoped to the domain and handles more than 90 addresses", async (t) => {
	const { env, raw } = await createFixture(t, "enforce");
	const now = seconds(new Date());
	const insert = raw.prepare("INSERT INTO email_suppressions (id, domain_id, email, reason, source, first_event_at, last_event_at) VALUES (?, ?, ?, 'hard_bounce', 'ses', ?, ?)");
	for (let index = 0; index < 150; index += 1) insert.run(`s${index}`, "d1", `u${index}@x.org`, now, now);
	insert.run("other", "d2", "only-d2@x.org", now, now);
	const emails = Array.from({ length: 200 }, (_, index) => `u${index}@x.org`).concat("only-d2@x.org");
	const found = await service.findSuppressed(env, "d1", emails);
	assert.equal(found.size, 150);
	assert.equal(found.has("only-d2@x.org"), false);
});

test("recordDsnBounces records a failed recipient of a message we sent from that mailbox", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "record");
	addSent();
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) }), 1);
	assert.deepEqual(rows().map((row) => [row.domain_id, row.email, row.reason, row.source]), [["d1", "anna@example.org", "hard_bounce", "dsn"]]);
	assert.match(rows()[0].detail, /Recipient address rejected/);
});

test("recordDsnBounces trusts only a Message-ID we sent from this mailbox", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "record");
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) }), 0, "no such message");
	addSent({ id: "m-other", mailboxId: "mb2", from: "sales@other.org" });
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) }), 0, "sent from another mailbox");
	addSent({ id: "m-in", direction: "inbound", providerMessageId: "inbound-1@x.org" });
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn({ original: "Message-ID: <inbound-1@x.org>" })) }), 0, "inbound message");
	assert.deepEqual(rows(), []);
});

test("recordDsnBounces ignores recipients we never wrote to, soft failures and old messages", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "record");
	addSent();
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn({ recipient: "victim@elsewhere.org" })) }), 0, "forged recipient");
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn({ action: "delayed", status: "4.4.1" })) }), 0, "delayed");
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn({ status: "4.2.2" })) }), 0, "4.x.x");
	assert.deepEqual(rows(), []);
	const old = await createFixture(t, "record");
	old.addSent({ at: new Date(Date.now() - 40 * 24 * 3600 * 1000) });
	assert.equal(await service.recordDsnBounces(old.env, { mailboxId: "mb1", raw: toBuffer(dsn()) }), 0, "older than 30 days");
});

test("recordDsnBounces matches a Message-ID stored with angle brackets and bcc recipients", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "record");
	addSent({ providerMessageId: "<orig-1@mail.example.com>", to: "bob@example.org", cc: "carol@example.org" });
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn({ recipient: "Carol@Example.org" })) }), 1);
	assert.equal(rows()[0].email, "carol@example.org");
});

test("recordDsnBounces does not even parse in mode off", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "off");
	addSent();
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) }), 0);
	assert.deepEqual(rows(), []);
});

// ---- DSN trust model: a DSN alone never enforces ---------------------------------------

const origin = (id) => `Message-ID: <${id}@mail.example.com>`;

test("a DSN entry is stored unconfirmed and does not block sending in enforce mode", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "enforce");
	addSent();
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) }), 1);
	assert.deepEqual(rows().map((row) => [row.email, row.source, row.confirmed]), [["anna@example.org", "dsn", 0]]);
	assert.equal((await service.findSuppressed(env, "d1", ["anna@example.org"])).size, 0);
});

test("a second DSN for the same address from a different original message confirms it", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "enforce");
	addSent();
	addSent({ id: "m2", providerMessageId: "orig-2@mail.example.com" });
	await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) });
	await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) });
	assert.equal(rows()[0].confirmed, 0, "the same message twice is one witness");
	await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn({ original: origin("orig-2") })) });
	assert.deepEqual([rows()[0].confirmed, rows()[0].event_count], [1, 3]);
	assert.deepEqual([...await service.findSuppressed(env, "d1", ["anna@example.org"])], ["anna@example.org"]);
});

test("a provider event is enforced and a later unconfirmed DSN does not downgrade or overwrite it", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "enforce");
	addSent();
	await service.recordSuppressionEvents(env, { sender: "kevin@example.com", source: "ses", entries: [{ email: "anna@example.org", reason: "hard_bounce", detail: "550" }] });
	assert.equal(rows()[0].confirmed, 1);
	await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn()) });
	assert.deepEqual([rows()[0].confirmed, rows()[0].source, rows()[0].detail], [1, "ses", "550"]);
	assert.equal((await service.findSuppressed(env, "d1", ["anna@example.org"])).size, 1);
});

test("an unconfirmed provider entry (several Resend recipients) is stored but not enforced", async (t) => {
	const { env, rows } = await createFixture(t, "enforce");
	await service.recordSuppressionEvents(env, { sender: "kevin@example.com", source: "resend", entries: [{ email: "anna@example.org", reason: "hard_bounce", unconfirmed: true }] });
	assert.equal(rows()[0].confirmed, 0);
	assert.equal((await service.findSuppressed(env, "d1", ["anna@example.org"])).size, 0);
	await service.recordSuppressionEvents(env, { sender: "kevin@example.com", source: "ses", entries: [{ email: "anna@example.org", reason: "hard_bounce" }] });
	assert.equal(rows()[0].confirmed, 1, "a signed single-recipient event confirms it");
});

test("a manual entry is confirmed", async (t) => {
	const { env, rows } = await createFixture(t, "enforce");
	await service.recordSuppression(env, { domainId: "d1", email: "a@x.org", reason: "manual", source: "admin" });
	assert.equal(rows()[0].confirmed, 1);
});

test("recordDsnBounces de-duplicates final recipients and caps the entries per DSN", async (t) => {
	const { env, addSent, rows } = await createFixture(t, "record");
	addSent({ to: "anna@example.org" });
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: toBuffer(dsn({ recipients: ["anna@example.org", "Anna@Example.org", "anna@example.org"] })) }), 1);
	assert.equal(rows()[0].event_count, 1);
	const many = Array.from({ length: 80 }, (_, index) => `u${index}@example.org`);
	const big = await createFixture(t, "record");
	big.addSent({ to: many.join(", ") });
	assert.equal(await service.recordDsnBounces(big.env, { mailboxId: "mb1", raw: toBuffer(dsn({ recipients: many })) }), 50);
	assert.equal(big.rows().length, 50);
});

test("recordDsnBounces reads the mode before parsing: mode off never touches the message", async (t) => {
	const { env } = await createFixture(t, "off");
	const untouched = { get byteLength() { throw new Error("parsed in mode off"); } };
	assert.equal(await service.recordDsnBounces(env, { mailboxId: "mb1", raw: untouched }), 0);
});

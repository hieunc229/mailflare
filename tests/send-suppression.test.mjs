import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-send-suppression-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		send: join(root, "src/lib/email/send.ts"),
		utils: join(root, "src/lib/deliverability/suppression-utils.ts"),
		service: join(root, "src/lib/deliverability/suppression.ts"),
		autoReply: join(root, "src/lib/email/auto-reply.ts"),
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
const send = await load("send");
const utils = await load("utils");
const service = await load("service");
const { sendMailboxAutoReply } = await load("autoReply");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const seconds = (date) => Math.floor(date.getTime() / 1000);

async function createFixture(t, mode) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, sending_provider, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 'cloudflare', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 'primary', ?)").run(now);
	database.db.prepare("UPDATE app_settings SET suppression_mode = ? WHERE id = 'default'").run(mode);
	const suppress = (email, domainId = "d1", confirmed = 1) => database.db.prepare("INSERT INTO email_suppressions (id, domain_id, email, reason, source, confirmed, first_event_at, last_event_at) VALUES (?, ?, ?, 'hard_bounce', 'ses', ?, ?, ?)").run(crypto.randomUUID(), domainId, email, confirmed, now, now);
	const sent = [];
	const queued = [];
	const env = {
		DB: database,
		BUCKET: { put: async () => undefined, get: async () => null, delete: async () => undefined, head: async () => null },
		EMAIL: { send: async (message) => { sent.push(message); return { messageId: `<out-${sent.length}@example.com>` }; } },
		OUTBOUND_QUEUE: { send: async (message) => { queued.push(message); } },
	};
	const input = (overrides = {}) => ({ userId: "u1", mailboxId: "mb1", from: "kevin@example.com", to: "Anna <anna@example.org>", subject: "Hi", text: "hello", ...overrides });
	const count = (table) => database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
	return { env, sent, queued, suppress, input, count, raw: database.db };
}

test("enforce: a suppressed recipient fails the send before anything is stored", async (t) => {
	const { env, sent, suppress, input, count } = await createFixture(t, "enforce");
	suppress("anna@example.org");
	await assert.rejects(send.sendEmail(env, input({ cc: "ok@example.org" })), (error) => {
		// Each entry point is its own bundle, so identify the class by name rather than identity.
		assert.equal(error.constructor.name, "SuppressedRecipientError");
		assert.deepEqual(error.addresses, ["anna@example.org"]);
		assert.equal(error.code, "SUPPRESSED_RECIPIENT");
		return true;
	});
	assert.equal(count("messages"), 0);
	assert.equal(count("outbound_jobs"), 0);
	assert.equal(sent.length, 0);
});

test("enforce: bcc recipients are checked, and a clean send goes through", async (t) => {
	const { env, sent, suppress, input } = await createFixture(t, "enforce");
	suppress("hidden@example.org");
	await assert.rejects(send.sendEmail(env, input({ bcc: "Hidden <HIDDEN@example.org>" })), (error) => error.code === "SUPPRESSED_RECIPIENT" && error.addresses[0] === "hidden@example.org");
	await send.sendEmail(env, input());
	assert.equal(sent.length, 1);
});

test("record and off modes never block a send", async (t) => {
	for (const mode of ["record", "off"]) {
		const { env, sent, suppress, input } = await createFixture(t, mode);
		suppress("anna@example.org");
		await send.sendEmail(env, input());
		assert.equal(sent.length, 1, mode);
	}
});

test("the list is per sending domain: another domain's entry does not block", async (t) => {
	const { env, sent, raw, suppress, input } = await createFixture(t, "enforce");
	raw.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d2', 'u1', 'other.org', 'zone', 1)").run();
	suppress("anna@example.org", "d2");
	await send.sendEmail(env, input());
	assert.equal(sent.length, 1);
});

test("delivery time: recipients that became suppressed while queued are dropped and audited", async (t) => {
	const { env, sent, raw, suppress, input } = await createFixture(t, "enforce");
	const future = new Date(Date.now() + 3600_000).toISOString();
	const { messageId } = await send.sendEmail(env, input({ to: "anna@example.org, bob@example.org", cc: "cc@example.org", scheduledAt: future }));
	suppress("bob@example.org");
	assert.equal(await send.sendScheduledMessageNow(env, messageId), true);
	assert.deepEqual(sent[0].to, ["anna@example.org"]);
	assert.deepEqual(sent[0].cc, ["cc@example.org"]);
	const audit = raw.prepare("SELECT metadata FROM audit_logs WHERE action = 'email.suppressed_recipients_dropped'").get();
	assert.match(audit.metadata, /bob@example\.org/);
});

test("delivery time: nothing is sent when no recipient remains or the To list is emptied", async (t) => {
	const { env, sent, raw, suppress, input } = await createFixture(t, "enforce");
	const future = new Date(Date.now() + 3600_000).toISOString();
	const { messageId } = await send.sendEmail(env, input({ to: "anna@example.org", cc: "cc@example.org", scheduledAt: future }));
	suppress("anna@example.org");
	await assert.rejects(send.sendScheduledMessageNow(env, messageId), /suppression list/);
	assert.equal(sent.length, 0);
	assert.equal(raw.prepare("SELECT status FROM messages WHERE id = ?").get(messageId).status, "failed");
});

test("delivery time: record mode leaves recipients alone", async (t) => {
	const { env, sent, suppress, input } = await createFixture(t, "record");
	const future = new Date(Date.now() + 3600_000).toISOString();
	const { messageId } = await send.sendEmail(env, input({ to: "anna@example.org", scheduledAt: future }));
	suppress("anna@example.org");
	await send.sendScheduledMessageNow(env, messageId);
	assert.deepEqual(sent[0].to, ["anna@example.org"]);
});

test("auto-replies to a suppressed sender are skipped without an error", async (t) => {
	const { env, sent, suppress, raw } = await createFixture(t, "enforce");
	raw.prepare("UPDATE mailboxes SET auto_reply_enabled = 1, auto_reply_body = 'Away' WHERE id = 'mb1'").run();
	const base = { mailboxId: "mb1", userId: "u1", deliveredAddress: "kevin@example.com", fromAddress: "anna@example.org" };
	suppress("anna@example.org");
	await sendMailboxAutoReply(env, base);
	assert.equal(sent.length, 0);
	await sendMailboxAutoReply(env, { ...base, fromAddress: "bob@example.org" });
	assert.equal(sent.length, 1);
});

test("the 422 body and the JMAP type carry the addresses", () => {
	const error = new utils.SuppressedRecipientError(["a@x.org", "b@x.org"]);
	assert.deepEqual(utils.suppressedSubmissionError(error), { type: "invalidRecipients", description: error.message, invalidRecipients: ["a@x.org", "b@x.org"] });
	assert.deepEqual(utils.suppressedRecipientBody(error), { error: "These addresses bounced or reported spam: a@x.org, b@x.org", code: "SUPPRESSED_RECIPIENT", addresses: ["a@x.org", "b@x.org"] });
});

test("enforce: an unconfirmed entry (forged-DSN candidate) does not block the send or get dropped at delivery", async (t) => {
	const { env, sent, suppress, input } = await createFixture(t, "enforce");
	suppress("anna@example.org", "d1", 0);
	await service.assertNoSuppressedRecipients(env, "kevin@example.com", ["anna@example.org"]);
	await send.sendEmail(env, input());
	assert.equal(sent.length, 1);
	const kept = await service.dropSuppressedRecipients(env, "kevin@example.com", { to: ["anna@example.org"], cc: [], bcc: [] });
	assert.deepEqual([kept.to, kept.dropped], [["anna@example.org"], []]);
});

test("JMAP invalidRecipients echoes the client's original casing", () => {
	const error = new utils.SuppressedRecipientError(["anna@example.org", "bob@example.org"]);
	const result = utils.suppressedSubmissionError(error, ["Anna <Anna@Example.org>", null, "BOB@example.org, other@example.org"]);
	assert.deepEqual(result.invalidRecipients, ["Anna@Example.org", "BOB@example.org"]);
	assert.match(result.description, /Anna@Example\.org, BOB@example\.org/);
});

test("calendar invitees: a suppressed attendee is refused before the event is stored", async (t) => {
	const { env, suppress } = await createFixture(t, "enforce");
	suppress("anna@example.org");
	const base = { userId: "u1", mailboxId: "mb1", from: "kevin@example.com" };
	await assert.rejects(service.assertInviteesAllowed(env, { ...base, attendees: ["Bob@example.org", "Anna@Example.org"] }), (error) => error.code === "SUPPRESSED_RECIPIENT" && error.addresses.join() === "anna@example.org");
	await service.assertInviteesAllowed(env, { ...base, attendees: ["bob@example.org"] });
	const record = await createFixture(t, "record");
	record.suppress("anna@example.org");
	await service.assertInviteesAllowed(record.env, { ...base, attendees: ["anna@example.org"] });
});

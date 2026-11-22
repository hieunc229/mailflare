import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The real sendMailboxAutoReply against a migrated in-memory database; only the
// outbound send is stubbed and records each attempted message.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-auto-reply-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { sendMailboxAutoReply, isResponderActive } from "./src/lib/email/auto-reply.ts";
			export { getMailboxUpdateValues } from "./src/app/api/mailboxes/[id]/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "auto-reply-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"@": join(root, "src"),
		"cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"),
	},
	plugins: [{
		name: "auto-reply-send-stub",
		setup(b) {
			b.onResolve({ filter: /^@\/lib\/email\/send$/ }, () => ({ path: "@/lib/email/send", namespace: "auto-reply-send-stub" }));
			b.onLoad({ filter: /.*/, namespace: "auto-reply-send-stub" }, () => ({
				contents: `
					export async function sendEmail(env, input) {
						globalThis.__autoReplySent.push(input);
						if (globalThis.__autoReplySendError) throw globalThis.__autoReplySendError;
						return { messageId: "stub-message" };
					}
				`,
			}));
		},
	}],
	logLevel: "silent",
});
const {
	SqliteDatabase,
	applyMigrations,
	sendMailboxAutoReply,
	isResponderActive,
	getMailboxUpdateValues,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const SECOND = 1;
const DAY = 24 * 60 * 60 * SECOND;
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function setup(t, { enabled = 1, subject = "Out of office", body = "Away until Monday", startAt = null, endAt = null, activatedAt = null } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const db = database.db;
	db.prepare("INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u1', 'owner@ex.com', 'x', 'Owner', 1700000000)").run();
	db.prepare("INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u2', 'colleague@ex.com', 'x', 'Colleague', 1700000000)").run();
	db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'ex.com', 'z1', 'active', 1700000000)").run();
	db.prepare(`INSERT INTO mailboxes (id, user_id, domain_id, local_part, auto_reply_enabled, auto_reply_subject, auto_reply_body,
		auto_reply_start_at, auto_reply_end_at, auto_reply_activated_at, created_at)
		VALUES ('m1', 'u1', 'd1', 'admin', ?, ?, ?, ?, ?, ?, 1700000000)`).run(enabled, subject, body, startAt, endAt, activatedAt);
	db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m2', 'u1', 'd1', 'other', 1700000000)").run();
	db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m3', 'u2', 'd1', 'colleague', 1700000000)").run();
	return { env: { DB: database }, db };
}

const call = (env, over = {}) => sendMailboxAutoReply(env, {
	mailboxId: "m1",
	userId: "u1",
	deliveredAddress: "admin@ex.com",
	fromAddress: "sender@other.example",
	envelopeFrom: "sender@other.example",
	incomingMessageId: "<in-1@other.example>",
	headers: { "Message-ID": "<in-1@other.example>" },
	...over,
});

const sent = () => globalThis.__autoReplySent;
const recordDelivery = (db, recipient, sentAtSeconds) =>
	db.prepare("INSERT INTO auto_reply_deliveries (id, mailbox_id, recipient, sent_at) VALUES (?, 'm1', ?, ?)")
		.run(`d-${recipient}-${sentAtSeconds}`, recipient, sentAtSeconds);
const deliveryCount = (db, recipient) =>
	db.prepare("SELECT count(*) AS count FROM auto_reply_deliveries WHERE mailbox_id = 'm1' AND recipient = ?").get(recipient).count;

beforeEach(() => {
	globalThis.__autoReplySent = [];
	globalThis.__autoReplySendError = null;
});

test("an enabled responder replies once per sender and stamps the reply", async (t) => {
	const { env, db } = await setup(t, { activatedAt: nowSeconds() - DAY });
	await call(env);
	assert.equal(sent().length, 1);
	const reply = sent()[0];
	assert.equal(reply.to, "sender@other.example");
	assert.equal(reply.subject, "Out of office");
	assert.equal(reply.text, "Away until Monday");
	assert.equal(reply.headers["Auto-Submitted"], "auto-replied");
	assert.equal(reply.headers["In-Reply-To"], "<in-1@other.example>");
	assert.equal(reply.headers.References, "<in-1@other.example>");
	assert.equal(deliveryCount(db, "sender@other.example"), 1);

	await call(env);
	assert.equal(sent().length, 1, "a second message from the same sender stays unanswered");
});

test("a different sender still gets a reply", async (t) => {
	const { env } = await setup(t, { activatedAt: nowSeconds() - DAY });
	await call(env);
	await call(env, { fromAddress: "friend@other.example" });
	assert.equal(sent().length, 2);
});

test("a disabled responder does not reply", async (t) => {
	const { env } = await setup(t, { enabled: 0 });
	await call(env);
	assert.equal(sent().length, 0);
});

test("an empty body disables the responder", async (t) => {
	const { env } = await setup(t, { body: "   " });
	await call(env);
	assert.equal(sent().length, 0);
});

test("the responder is inactive before its start date", async (t) => {
	const { env } = await setup(t, { startAt: nowSeconds() + DAY });
	await call(env);
	assert.equal(sent().length, 0);
});

test("the responder is inactive after its end date", async (t) => {
	const { env } = await setup(t, { startAt: nowSeconds() - 14 * DAY, endAt: nowSeconds() - DAY });
	await call(env);
	assert.equal(sent().length, 0);
});

test("the responder replies inside its window", async (t) => {
	const { env } = await setup(t, { startAt: nowSeconds() - DAY, endAt: nowSeconds() + 7 * DAY, activatedAt: nowSeconds() - 14 * DAY });
	await call(env);
	assert.equal(sent().length, 1);
});

test("a delivery older than four days no longer suppresses a reply", async (t) => {
	const { env, db } = await setup(t, { activatedAt: nowSeconds() - 14 * DAY });
	recordDelivery(db, "sender@other.example", nowSeconds() - 5 * DAY);
	await call(env);
	assert.equal(sent().length, 1);
});

test("a delivery inside the window suppresses a reply", async (t) => {
	const { env, db } = await setup(t, { activatedAt: nowSeconds() - 14 * DAY });
	recordDelivery(db, "sender@other.example", nowSeconds() - DAY);
	await call(env);
	assert.equal(sent().length, 0);
});

test("disabling and re-enabling the responder resets the throttle", async (t) => {
	const { env, db } = await setup(t, { enabled: 1, activatedAt: nowSeconds() - 30 * DAY });
	recordDelivery(db, "sender@other.example", nowSeconds() - DAY);
	await call(env);
	assert.equal(sent().length, 0, "still throttled before the reset");

	// The PATCH path stamps activation only on a real off->on transition.
	const off = getMailboxUpdateValues({ autoReplyEnabled: false }, { autoReplyEnabled: true });
	assert.equal(off.autoReplyActivatedAt, null);
	const on = getMailboxUpdateValues({ autoReplyEnabled: true }, { autoReplyEnabled: false });
	assert.ok(on.autoReplyActivatedAt instanceof Date);
	const already = getMailboxUpdateValues({ autoReplyEnabled: true }, { autoReplyEnabled: true });
	assert.ok(!("autoReplyActivatedAt" in already), "re-saving an enabled responder keeps its activation stamp");

	db.prepare("UPDATE mailboxes SET auto_reply_enabled = 0, auto_reply_activated_at = NULL WHERE id = 'm1'").run();
	db.prepare("UPDATE mailboxes SET auto_reply_enabled = 1, auto_reply_activated_at = ? WHERE id = 'm1'").run(nowSeconds());
	await call(env);
	assert.equal(sent().length, 1, "the first sender gets a fresh reply after re-enabling");
});

test("a failed send is not counted", async (t) => {
	const { env, db } = await setup(t, { activatedAt: nowSeconds() - DAY });
	globalThis.__autoReplySendError = new Error("provider down");
	await assert.rejects(() => call(env));
	assert.equal(deliveryCount(db, "sender@other.example"), 0);
	globalThis.__autoReplySendError = null;
	await call(env);
	assert.equal(sent().length, 2, "the sender is retried because the failure left no throttle row");
	assert.equal(deliveryCount(db, "sender@other.example"), 1);
});

test("guardrails: bulk, list and automated mail get no reply", async (t) => {
	const { env } = await setup(t, { activatedAt: nowSeconds() - DAY });
	const cases = [
		{ headers: { Precedence: "bulk" } },
		{ headers: { Precedence: "list" } },
		{ headers: { Precedence: "junk" } },
		{ headers: { "List-Id": "<announce.other.example>" } },
		{ headers: { "Auto-Submitted": "auto-replied" } },
		{ headers: { "auto-submitted": "auto-generated" } },
		{ headers: { "X-Autoreply": "yes" } },
		{ headers: { "X-Autorespond": "yes" } },
		{ headers: { "X-Auto-Response-Suppress": "All" } },
		{ envelopeFrom: "<>" },
		{ envelopeFrom: "" },
		{ headers: { "Return-Path": "<>" } },
		{ fromAddress: "MAILER-DAEMON@other.example" },
		{ fromAddress: "postmaster@other.example" },
		{ fromAddress: "noreply@other.example" },
		{ fromAddress: "no-reply@other.example" },
		{ fromAddress: "do_not_reply@other.example" },
		{ fromAddress: "notifications-noreply@other.example" },
		{ fromAddress: "bounce@other.example" },
		{ fromAddress: "admin@ex.com" },
		{ fromAddress: "other@ex.com" },
	];
	for (const [index, over] of cases.entries()) {
		const fromAddress = over.fromAddress ?? `sender-${index}@other.example`;
		await call(env, { fromAddress, ...over });
	}
	assert.equal(sent().length, 0, `guardrail cases sent replies: ${sent().map((reply) => reply.to).join(", ")}`);
});

test("a colleague's mailbox on the same account gets no reply, another user does", async (t) => {
	const { env } = await setup(t, { activatedAt: nowSeconds() - DAY });
	await call(env, { fromAddress: "other@ex.com" });
	await call(env, { fromAddress: "colleague@ex.com" });
	assert.deepEqual(sent().map((reply) => reply.to), ["colleague@ex.com"]);
});

test("isResponderActive honours the window", () => {
	const base = { autoReplyEnabled: true, autoReplyBody: "away", autoReplyStartAt: null, autoReplyEndAt: null };
	const now = new Date("2026-02-01T12:00:00Z");
	assert.equal(isResponderActive({ ...base }, now), true);
	assert.equal(isResponderActive({ ...base, autoReplyEnabled: false }, now), false);
	assert.equal(isResponderActive({ ...base, autoReplyBody: " " }, now), false);
	assert.equal(isResponderActive({ ...base, autoReplyStartAt: new Date("2026-02-02T00:00:00Z") }, now), false);
	assert.equal(isResponderActive({ ...base, autoReplyStartAt: new Date("2026-01-30T00:00:00Z") }, now), true);
	assert.equal(isResponderActive({ ...base, autoReplyEndAt: new Date("2026-01-31T00:00:00Z") }, now), false);
	assert.equal(isResponderActive({ ...base, autoReplyEndAt: new Date("2026-02-10T00:00:00Z") }, now), true);
});

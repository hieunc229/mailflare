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
			export { scheduleAutoDraft } from "./src/lib/agent/jobs/utils.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export * as detail from "./src/app/api/mailboxes/[id]/route.ts";
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
		name: "auto-reply-stubs",
		setup(b) {
			// The PATCH test authenticates by Bearer token, so cookies() never runs;
			// NextResponse only has to carry the status and JSON body back.
			b.onResolve({ filter: /^next\/(headers|server)$/ }, (args) => ({ path: args.path, namespace: "next-stub" }));
			b.onLoad({ filter: /.*/, namespace: "next-stub" }, (args) => ({
				contents: args.path === "next/server"
					? `export class NextResponse extends Response { static json(data, init) { return Response.json(data, init); } }`
					: `export async function cookies() { return { get() { return undefined; } }; }`,
			}));
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
	scheduleAutoDraft,
	createSession,
	detail,
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

// The scheduling fixture adds the agent settings row, a source message the job
// attaches to, and a queue that records every enqueue.
async function draftSetup(t, mailbox = {}) {
	const { env, db } = await setup(t, mailbox);
	db.prepare("INSERT INTO mailbox_agent_settings (mailbox_id, enabled, auto_draft_enabled, updated_at) VALUES ('m1', 1, 1, 1700000000)").run();
	db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, created_at) VALUES ('src1', 'u1', 'm1', 'inbound', 'sender@other.example', 'admin@ex.com', 1700000000)").run();
	const queue = [];
	env.AGENT_QUEUE = { send: async (message) => queue.push(message) };
	return { env, db, queue };
}

const draftInput = { mailboxId: "m1", sourceMessageId: "src1", ownerUserId: "u1", sender: "sender@other.example", status: "received", folderId: null };
const draftJobCount = (db) => db.prepare("SELECT count(*) AS count FROM agent_jobs WHERE mailbox_id = 'm1'").get().count;

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

test("a second message two or three days later is still inside the throttle", async (t) => {
	for (const days of [2, 3]) {
		const { env, db } = await setup(t, { activatedAt: nowSeconds() - 14 * DAY });
		await call(env);
		assert.equal(sent().length, 1);
		// Time passes: the first reply now sits `days` in the past, inside the
		// four-day throttle, and the sender writes again.
		db.prepare("UPDATE auto_reply_deliveries SET sent_at = ? WHERE mailbox_id = 'm1'").run(nowSeconds() - days * DAY);
		globalThis.__autoReplySent = [];
		await call(env, { incomingMessageId: `<in-${days}@other.example>` });
		assert.equal(sent().length, 0, `a message ${days} days after the reply stays unanswered`);
	}
});

test("a delivery before the current window's start no longer suppresses a reply", async (t) => {
	// An earlier vacation ended and a new window opened a day ago. The sender's
	// last reply predates this window, so the throttle starts over.
	const start = nowSeconds() - DAY;
	const { env, db } = await setup(t, { startAt: start, endAt: nowSeconds() + 6 * DAY, activatedAt: nowSeconds() - 30 * DAY });
	recordDelivery(db, "sender@other.example", start - 1);
	await call(env);
	assert.equal(sent().length, 1);
});

test("a delivery at the window's start still suppresses a reply", async (t) => {
	// The floor is inclusive: a reply stamped exactly when this window opened
	// belongs to the current window and throttles the sender.
	const start = nowSeconds() - DAY;
	const { env, db } = await setup(t, { startAt: start, endAt: nowSeconds() + 6 * DAY, activatedAt: nowSeconds() - 30 * DAY });
	recordDelivery(db, "sender@other.example", start);
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
	// The window is closed-interval: it activates at its start instant and is
	// still active at its end instant, never a millisecond early or late.
	assert.equal(isResponderActive({ ...base, autoReplyStartAt: now }, now), true);
	assert.equal(isResponderActive({ ...base, autoReplyEndAt: now }, now), true);
	assert.equal(isResponderActive({ ...base, autoReplyStartAt: new Date(now.getTime() + 1) }, now), false);
	assert.equal(isResponderActive({ ...base, autoReplyEndAt: new Date(now.getTime() - 1) }, now), false);
});

test("auto-draft scheduling skips only while the responder is actually active", async (t) => {
	// The responder's flag alone must not suppress drafts: only a responder
	// that is enabled, has a body and sits inside its window does.
	for (const [name, mailbox, expected] of [
		["disabled responder still drafts", { enabled: 0 }, 1],
		["empty body still drafts", { body: " " }, 1],
		["a window starting tomorrow still drafts", { startAt: nowSeconds() + DAY }, 1],
		["a window that ended yesterday still drafts", { startAt: nowSeconds() - 14 * DAY, endAt: nowSeconds() - DAY }, 1],
		["an open window suppresses drafts", { startAt: nowSeconds() - DAY, endAt: nowSeconds() + DAY }, 0],
		["a windowless responder suppresses drafts", {}, 0],
	]) {
		const { env, db, queue } = await draftSetup(t, mailbox);
		await scheduleAutoDraft(env, draftInput);
		assert.equal(draftJobCount(db), expected, `${name}: job row`);
		assert.equal(queue.length, expected, `${name}: queue message`);
	}
});

test("a job enqueued before the window opens is the process-time check's problem", async (t) => {
	// Enqueue-time and process-time predicates share isResponderActive: a draft
	// scheduled just before the window opens is enqueued now and re-checked
	// when the job runs.
	const { env, db, queue } = await draftSetup(t, { startAt: nowSeconds() + 60 });
	await scheduleAutoDraft(env, draftInput);
	assert.equal(draftJobCount(db), 1);
	assert.equal(queue.length, 1);
});

test("the mailbox PATCH stamps the activation when the responder turns on", async (t) => {
	const { env, db } = await setup(t, { enabled: 0 });
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await createSession(env, "u1");
	const patch = (body) => detail.PATCH(new Request("https://mail.test/api/mailboxes/m1", {
		method: "PATCH",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}), { params: Promise.resolve({ id: "m1" }) });
	const stamp = () => db.prepare("SELECT auto_reply_activated_at AS stamp FROM mailboxes WHERE id = 'm1'").get().stamp;

	const before = nowSeconds();
	const turnedOn = await patch({ autoReplyEnabled: true });
	assert.equal(turnedOn.status, 200);
	const first = stamp();
	assert.ok(first >= before && first <= nowSeconds(), "the off->on transition stamps the activation");

	const savedAgain = await patch({ autoReplyEnabled: true });
	assert.equal(savedAgain.status, 200);
	assert.equal(stamp(), first, "re-saving an enabled responder keeps its stamp");

	const turnedOff = await patch({ autoReplyEnabled: false });
	assert.equal(turnedOff.status, 200);
	assert.equal(stamp(), null, "turning the responder off clears the stamp");
});

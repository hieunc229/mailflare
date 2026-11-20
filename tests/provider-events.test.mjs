import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-provider-events-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		events: join(root, "src/lib/deliverability/provider-events.ts"),
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
const events = await load("events");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const seconds = (date) => Math.floor(date.getTime() / 1000);

const SECRET_BYTES = Buffer.from("resend-events-secret-for-tests!!");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const TOKEN = "tok123";
const TOPIC = "arn:aws:sns:us-east-1:111122223333:mailflare-feedback";

async function createFixture(t, mode = "record") {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', ?)").run(now);
	database.db.prepare("UPDATE app_settings SET suppression_mode = ?, resend_events_webhook_secret = ?, ses_feedback = ? WHERE id = 'default'")
		.run(mode, SECRET, JSON.stringify({ region: "us-east-1", topicArn: TOPIC, token: TOKEN, endpoint: "https://x/api/provider-events/ses?token=tok123", identities: ["example.com"] }));
	const stored = new Set();
	const touched = [];
	const env = { DB: database, BUCKET: { head: async (key) => { touched.push(key); return stored.has(key) ? {} : null; }, put: async (key) => { touched.push(key); stored.add(key); } } };
	const rows = () => database.db.prepare("SELECT domain_id, email, reason, source, event_count FROM email_suppressions ORDER BY email").all();
	return { env, rows, stored, touched, raw: database.db };
}

const sign = (id, timestamp, body, secret = SECRET_BYTES) => `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
function resendRequest(payload, { id = "msg_1", timestamp = String(Math.floor(Date.now() / 1000)), secret } = {}) {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	return { body, headers: { id, timestamp, signature: sign(id, timestamp, body, secret) } };
}
const bounced = { type: "email.bounced", data: { from: "Kevin <kevin@example.com>", to: ["anna@example.org"], bounce: { type: "Permanent", message: "no such user" } } };

test("resend: a signed bounce is recorded for the sender's domain", async (t) => {
	const { env, rows } = await createFixture(t);
	const result = await events.processResendEvent(env, resendRequest(bounced));
	assert.equal(result.status, 200);
	assert.deepEqual(rows(), [{ domain_id: "d1", email: "anna@example.org", reason: "hard_bounce", source: "resend", event_count: 1 }]);
});

test("resend: bad signature, wrong secret and stale timestamp are rejected and record nothing", async (t) => {
	const { env, rows } = await createFixture(t);
	const good = resendRequest(bounced);
	assert.equal((await events.processResendEvent(env, { ...good, body: good.body.replace("anna", "mallory") })).status, 401);
	assert.equal((await events.processResendEvent(env, resendRequest(bounced, { secret: Buffer.from("another-secret-another-secret-12") }))).status, 401);
	assert.equal((await events.processResendEvent(env, resendRequest(bounced, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) }))).status, 401);
	assert.equal((await events.processResendEvent(env, { body: good.body, headers: { id: null, timestamp: null, signature: null } })).status, 401);
	assert.deepEqual(rows(), []);
});

test("resend: without a stored secret the endpoint is unavailable", async (t) => {
	const { env, raw } = await createFixture(t);
	raw.prepare("UPDATE app_settings SET resend_events_webhook_secret = NULL").run();
	assert.equal((await events.processResendEvent(env, resendRequest(bounced))).status, 503);
});

test("resend: a replayed svix-id is processed once", async (t) => {
	const { env, rows } = await createFixture(t);
	await events.processResendEvent(env, resendRequest(bounced));
	const again = await events.processResendEvent(env, resendRequest(bounced));
	assert.equal(again.status, 200);
	assert.equal(rows()[0].event_count, 1);
});

test("resend: oversized bodies are refused before any work", async (t) => {
	const { env } = await createFixture(t);
	assert.equal((await events.processResendEvent(env, resendRequest("x".repeat(300 * 1024)))).status, 413);
});

test("resend: soft bounces, other events and unknown domains return 200 and record nothing", async (t) => {
	const { env, rows } = await createFixture(t);
	let n = 0;
	for (const payload of [
		{ ...bounced, data: { ...bounced.data, bounce: { type: "Temporary" } } },
		{ type: "email.delivered", data: bounced.data },
		{ ...bounced, data: { ...bounced.data, from: "x@unknown.test" } },
	]) {
		const result = await events.processResendEvent(env, resendRequest(payload, { id: `msg_${n += 1}` }));
		assert.equal(result.status, 200);
	}
	assert.deepEqual(rows(), []);
});

test("resend: mode off verifies, answers 200 and records nothing", async (t) => {
	const { env, rows } = await createFixture(t, "off");
	assert.equal((await events.processResendEvent(env, resendRequest(bounced))).status, 200);
	assert.deepEqual(rows(), []);
	assert.deepEqual(await createFixture(t, "off").then(async ({ env: offEnv, touched }) => { await events.processResendEvent(offEnv, resendRequest(bounced)); return touched; }), [], "no replay marker is read or written");
	const forged = resendRequest(bounced, { id: "msg_f", secret: Buffer.from("another-secret-another-secret-12") });
	assert.equal((await events.processResendEvent(env, forged)).status, 401);
});

test("resend: one recipient is enforced, several recipients are stored unconfirmed", async (t) => {
	const { env, raw } = await createFixture(t);
	await events.processResendEvent(env, resendRequest(bounced, { id: "msg_a" }));
	const many = { ...bounced, data: { ...bounced.data, to: ["bob@example.org", "carol@example.org"] } };
	await events.processResendEvent(env, resendRequest(many, { id: "msg_b" }));
	const confirmed = raw.prepare("SELECT email, confirmed FROM email_suppressions ORDER BY email").all();
	assert.deepEqual(confirmed.map((row) => [row.email, row.confirmed]), [["anna@example.org", 1], ["bob@example.org", 0], ["carol@example.org", 0]]);
});

// ---- SES ----------------------------------------------------------------------------

const notification = (message, overrides = {}) => JSON.stringify({ Type: "Notification", MessageId: "11111111-2222", TopicArn: TOPIC, Message: JSON.stringify(message), ...overrides });
const sesBounce = { notificationType: "Bounce", mail: { source: "kevin@example.com" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "anna@example.org", diagnosticCode: "550" }] } };
const accept = async () => true;
const reject = async () => false;

test("ses: token, topic and signature are checked in that order and each failure records nothing", async (t) => {
	const { env, rows } = await createFixture(t);
	assert.equal((await events.processSesFeedback(env, { token: "wrong", body: notification(sesBounce) }, accept)).status, 403);
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: notification(sesBounce, { TopicArn: "arn:other" }) }, accept)).status, 403);
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: notification(sesBounce) }, reject)).status, 403);
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: "not json" }, accept)).status, 400);
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: "x".repeat(300 * 1024) }, accept)).status, 413);
	assert.deepEqual(rows(), []);
});

test("ses: a verified permanent bounce and a complaint are recorded; replays are ignored", async (t) => {
	const { env, rows } = await createFixture(t);
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: notification(sesBounce) }, accept)).status, 200);
	await events.processSesFeedback(env, { token: TOKEN, body: notification(sesBounce) }, accept);
	const complaint = { notificationType: "Complaint", mail: { source: "kevin@example.com" }, complaint: { complainedRecipients: [{ emailAddress: "carol@example.org" }] } };
	await events.processSesFeedback(env, { token: TOKEN, body: notification(complaint, { MessageId: "33333333-4444" }) }, accept);
	assert.deepEqual(rows().map((row) => [row.email, row.reason, row.source, row.event_count]), [["anna@example.org", "hard_bounce", "ses", 1], ["carol@example.org", "complaint", "ses", 1]]);
});

test("ses: transient bounces are ignored and mode off records nothing", async (t) => {
	const { env, rows } = await createFixture(t);
	const transient = { ...sesBounce, bounce: { ...sesBounce.bounce, bounceType: "Transient" } };
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: notification(transient) }, accept)).status, 200);
	const off = await createFixture(t, "off");
	assert.equal((await events.processSesFeedback(off.env, { token: TOKEN, body: notification(sesBounce) }, accept)).status, 200);
	assert.deepEqual([...rows(), ...off.rows()], []);
	assert.deepEqual(off.touched, [], "no replay marker is read or written in mode off");
});

test("ses: a subscription confirmation only follows an sns.<region>.amazonaws.com https URL", async (t) => {
	const { env } = await createFixture(t);
	const fetched = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response("ok"); };
	t.after(() => { globalThis.fetch = original; });
	const confirm = (SubscribeURL) => JSON.stringify({ Type: "SubscriptionConfirmation", MessageId: "m", TopicArn: TOPIC, SubscribeURL });
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: confirm("https://evil.example.com/?x") }, accept)).status, 400);
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: confirm("http://sns.us-east-1.amazonaws.com/?x") }, accept)).status, 400);
	assert.deepEqual(fetched, []);
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: confirm("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription") }, accept)).status, 200);
	assert.equal(fetched.length, 1);
});

test("ses: without feed state the endpoint refuses everything", async (t) => {
	const { env, raw } = await createFixture(t);
	raw.prepare("UPDATE app_settings SET ses_feedback = NULL").run();
	assert.equal((await events.processSesFeedback(env, { token: TOKEN, body: notification(sesBounce) }, accept)).status, 403);
});

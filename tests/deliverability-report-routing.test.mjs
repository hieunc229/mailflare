import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-report-routing-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		incoming: join(root, "src/lib/email/incoming.ts"),
		inbound: join(root, "src/lib/email/inbound.ts"),
		intake: join(root, "src/lib/email/intake.ts"),
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
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "postal-mime", "cloudflare:workers", "agents", "agents/*"],
	logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { resolveIncomingMail } = await load("incoming");
const { processInboundMessage } = await load("inbound");
const { intakeIncomingMail } = await load("intake");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const seconds = (date) => Math.floor(date.getTime() / 1000);
const google = readFileSync(join(root, "tests/fixtures/dmarc/google.xml"), "utf8").replace(/<begin>\d+<\/begin>/, `<begin>${seconds(new Date()) - 3600}</begin>`);

async function fixture(t, { enabled = true } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 'active', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', ?)").run(now);
	database.db.prepare("INSERT INTO domain_deliverability (domain_id, reports_enabled, updated_at) VALUES ('d1', ?, ?)").run(enabled ? 1 : 0, now);
	// A catch-all reject rule: without the report exception it would swallow every unknown address.
	database.db.prepare("INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, match_value, action, reject_reason, created_at) VALUES ('r1', 'u1', 'd1', 'domain', '*', '*', 'reject', 'No such user', ?)").run(now);
	const objects = new Map();
	const deleted = [];
	const env = { DB: database, BUCKET: { async get(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } : null; }, async delete(key) { deleted.push(key); objects.delete(key); } } };
	return { env, raw: database.db, objects, deleted };
}

function reportMail(xml) {
	const boundary = "b0undary";
	return Buffer.from(`From: noreply-dmarc-support@google.com\r\nTo: mailflare-reports@example.com\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=${boundary}\r\n\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nreport\r\n--${boundary}\r\nContent-Type: application/gzip\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="r.xml.gz"\r\n\r\n${gzipSync(xml).toString("base64")}\r\n--${boundary}--\r\n`);
}

test("a catch-all reject rule does not swallow the report address, but still rejects other unknown addresses", async (t) => {
	const { env } = await fixture(t);
	assert.deepEqual(await resolveIncomingMail(env, "noreply@google.com", "mailflare-reports@example.com"), { action: "report" });
	assert.equal((await resolveIncomingMail(env, "noreply@google.com", "nobody@example.com"))?.action, "reject");
});

test("report mail is stored and queued for the report consumer but never forwarded, even with a catch-all forward rule", async (t) => {
	const { env, raw } = await fixture(t);
	raw.prepare("DELETE FROM routing_rules").run();
	raw.prepare("INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, match_value, action, forward_to, created_at) VALUES ('f1', 'u1', 'd1', 'domain', '*', '*', 'forward', 'elsewhere@example.net', 1)").run();
	const forwards = [];
	const queued = [];
	const stored = [];
	env.INBOUND_QUEUE = { send: async (message) => { queued.push(message); } };
	env.BUCKET.put = async (key) => { stored.push(key); };
	const actions = { forward: async (destination) => { forwards.push(destination); return true; } };
	const input = (to) => ({ from: "noreply-dmarc-support@google.com", to, raw: new TextEncoder().encode("raw").buffer, headers: { from: "noreply-dmarc-support@google.com" } });
	const result = await intakeIncomingMail(env, input("mailflare-reports@example.com"), actions);
	assert.equal(result.action, "store");
	assert.deepEqual(forwards, []);
	assert.deepEqual([stored.length, queued.length, queued[0].to], [1, 1, "mailflare-reports@example.com"]);
	// Any other unknown address still follows the catch-all forward rule.
	const other = await intakeIncomingMail(env, input("nobody@example.com"), actions);
	assert.equal(other.action, "forward");
	assert.deepEqual(forwards, ["elsewhere@example.net"]);
});

test("report mail is not sent to an account's forwarding address when a catch-all lands on that mailbox", async (t) => {
	const { env, raw } = await fixture(t);
	raw.prepare("DELETE FROM routing_rules").run();
	raw.prepare("INSERT INTO routing_rules (id, user_id, domain_id, mailbox_id, scope, pattern, match_value, action, created_at) VALUES ('c1', 'u1', 'd1', 'mb1', 'domain', '*', '*', 'store', 1)").run();
	raw.prepare("UPDATE users SET forwarding_email = 'kevin@gmail.example'").run();
	raw.prepare("INSERT INTO license_settings (id, instance_id, state, plan, updated_at) VALUES ('default', 'i1', 'active', 'pro', 1)").run();
	env.INBOUND_QUEUE = { send: async () => {} };
	env.BUCKET.put = async () => {};
	const forwards = [];
	const actions = { forward: async (destination) => { forwards.push(destination); return true; } };
	const input = (to) => ({ from: "noreply-dmarc-support@google.com", to, raw: new TextEncoder().encode("raw").buffer, headers: {} });
	await intakeIncomingMail(env, input("somebody@example.com"), actions);
	assert.deepEqual(forwards, ["kevin@gmail.example"], "the account forwarding is real for ordinary mail");
	forwards.length = 0;
	await intakeIncomingMail(env, input("mailflare-reports@example.com"), actions);
	assert.deepEqual(forwards, []);
});

test("with reporting off the reserved address routes like any other address", async (t) => {
	const { env } = await fixture(t, { enabled: false });
	assert.equal((await resolveIncomingMail(env, "noreply@google.com", "mailflare-reports@example.com"))?.action, "reject");
});

test("a queued report mail is ingested instead of routed to a mailbox, and the raw object is removed", async (t) => {
	const { env, raw, objects, deleted } = await fixture(t);
	objects.set("raw/report", reportMail(google));
	await processInboundMessage(env, { from: "noreply-dmarc-support@google.com", to: "mailflare-reports@example.com", rawR2Key: "raw/report", headers: { from: "Google <noreply-dmarc-support@google.com>", "authentication-results": "mx.cloudflare.net; dmarc=pass" } });
	assert.equal(raw.prepare("SELECT count(*) AS n FROM messages").get().n, 0, "no message was stored in any mailbox");
	const [report] = raw.prepare("SELECT status, authenticated, message_count FROM deliverability_reports").all();
	assert.deepEqual({ ...report }, { status: "ok", authenticated: 1, message_count: 50 });
	assert.equal(raw.prepare("SELECT sender_domain FROM deliverability_reports").get().sender_domain, "google.com", "the From header, not the envelope, names the sender");
	assert.equal(raw.prepare("SELECT count(*) AS n FROM dmarc_daily_stats").get().n, 3);
	assert.deepEqual(deleted, ["raw/report"]);
});

test("a report mail whose own DMARC verdict is missing is stored as unauthenticated", async (t) => {
	const { env, raw, objects } = await fixture(t);
	objects.set("raw/report", reportMail(google));
	await processInboundMessage(env, { from: "x@evil.example", to: "mailflare-reports@example.com", rawR2Key: "raw/report", headers: {} });
	assert.equal(raw.prepare("SELECT authenticated FROM deliverability_reports").get().authenticated, 0);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM dmarc_daily_stats").get().n, 0);
});

test("with reporting off, mail to the reserved address follows normal routing and is never ingested", async (t) => {
	const { env, raw, objects } = await fixture(t, { enabled: false });
	objects.set("raw/report", reportMail(google));
	await processInboundMessage(env, { from: "noreply-dmarc-support@google.com", to: "mailflare-reports@example.com", rawR2Key: "raw/report", headers: {} });
	assert.equal(raw.prepare("SELECT count(*) AS n FROM deliverability_reports").get().n, 0);
});

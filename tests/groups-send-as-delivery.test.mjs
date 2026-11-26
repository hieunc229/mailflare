import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-groups-send-as-delivery-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		send: join(root, "src/lib/email/send.ts"),
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
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function fixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, created_at) VALUES
			('alice', 'alice@example.com', 'Alice', 'x', 1), ('bob', 'bob@example.com', 'Bob', 'x', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, sending_provider, created_at) VALUES ('d1', 'alice', 'example.com', 'zone', 'cloudflare', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('m-alice', 'alice', 'd1', 'alice', 'personal', 1), ('m-bob', 'bob', 'd1', 'bob', 'personal', 1);
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
		INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 1, 1);
		INSERT INTO mail_group_members (id, group_id, kind, user_id, can_send_as, created_at) VALUES ('gm1', 'g1', 'user', 'alice', 1, 1), ('gm2', 'g1', 'user', 'bob', 0, 1);
	`);
	const sent = [];
	const objects = new Map();
	const env = {
		DB: database,
		BUCKET: {
			put: async (key, body) => { objects.set(key, body); },
			get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null),
			delete: async (key) => { objects.delete(key); },
			head: async () => null,
		},
		EMAIL: { send: async (message) => { sent.push(message); return { messageId: `<out-${sent.length}@example.com>` }; } },
		OUTBOUND_QUEUE: { send: async () => undefined },
	};
	const input = (overrides = {}) => ({ userId: "alice", mailboxId: "m-alice", from: "team@example.com", to: "anna@example.org", subject: "Hi", text: "hello", ...overrides });
	const row = (id) => database.db.prepare("SELECT mailbox_id, from_addr, status FROM messages WHERE id = ?").get(id);
	return { env, sent, input, row, raw: database.db };
}

test("a flagged member's send goes out as the group and the Sent copy is in their mailbox", async (t) => {
	const { env, sent, input, row } = await fixture(t);
	const { messageId } = await send.sendEmail(env, input());
	assert.equal(sent.length, 1);
	assert.match(String(sent[0].from.email ?? sent[0].from), /team@example\.com/);
	assert.deepEqual({ ...row(messageId) }, { mailbox_id: "m-alice", from_addr: "\"Team\" <team@example.com>", status: "sent" });
});

test("a member without the flag cannot send, and nothing is stored", async (t) => {
	const { env, sent, input, raw } = await fixture(t);
	await assert.rejects(send.sendEmail(env, input({ userId: "bob", mailboxId: "m-bob" })), /Sender address does not match/);
	assert.equal(sent.length, 0);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
});

test("a send queued as the group is refused at delivery once the flag, the group or the licence is gone", async (t) => {
	for (const revoke of [
		"UPDATE mail_group_members SET can_send_as = 0 WHERE id = 'gm1'",
		"UPDATE mail_groups SET disabled = 1",
		"DELETE FROM mail_group_members WHERE id = 'gm1'",
		"UPDATE license_settings SET plan = 'community'",
	]) {
		const { env, sent, input, row, raw } = await fixture(t);
		const { messageId } = await send.sendEmail(env, input({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
		raw.exec(revoke);
		await assert.rejects(send.sendScheduledMessageNow(env, messageId), /no longer available/, revoke);
		assert.equal(sent.length, 0, revoke);
		assert.equal(row(messageId).status, "failed", revoke);
	}
});

test("a send queued as the group still goes out while the member keeps the flag", async (t) => {
	const { env, sent, input, row } = await fixture(t);
	const { messageId } = await send.sendEmail(env, input({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
	assert.equal(await send.sendScheduledMessageNow(env, messageId), true);
	assert.equal(sent.length, 1);
	assert.equal(row(messageId).status, "sent");
});

const audit = (raw, action) => raw.prepare("SELECT actor_user_id, mailbox_id, message_id, metadata FROM audit_logs WHERE action = ?").all(action).map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }));

test("a send as the group carries a signed marker and writes one send_as_group audit row", async (t) => {
	const { env, sent, input, raw } = await fixture(t);
	const { messageId } = await send.sendEmail(env, input());
	const header = Object.entries(sent[0].headers ?? {}).find(([name]) => name.toLowerCase() === "x-mailflare-send-as")?.[1];
	assert.match(header, new RegExp(`^v1\\.${messageId}\\.g1\\.[0-9a-f]{64}$`));
	assert.deepEqual(audit(raw, "email.send_as_group"), [{ actor_user_id: "alice", mailbox_id: "m-alice", message_id: messageId, metadata: { groupId: "g1", address: "team@example.com" } }]);
});

test("a scheduled send as the group keeps its marker", async (t) => {
	const { env, sent, input } = await fixture(t);
	const { messageId } = await send.sendEmail(env, input({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
	await send.sendScheduledMessageNow(env, messageId);
	assert.ok(Object.keys(sent[0].headers ?? {}).some((name) => name.toLowerCase() === "x-mailflare-send-as"));
});

test("a plain send from the member's own address has no marker and no send_as_group row", async (t) => {
	const { env, sent, input, raw } = await fixture(t);
	await send.sendEmail(env, input({ from: "alice@example.com" }));
	assert.equal(sent.length, 1);
	assert.ok(!Object.keys(sent[0].headers ?? {}).some((name) => name.toLowerCase() === "x-mailflare-send-as"));
	assert.deepEqual(audit(raw, "email.send_as_group"), []);
});

test("a group name with control characters cannot split the From header", async (t) => {
	const { env, input, raw, row } = await fixture(t);
	raw.exec("UPDATE mail_groups SET name = 'Team' || char(13) || char(10) || 'Bcc: evil@example.net'");
	const { messageId } = await send.sendEmail(env, input());
	assert.doesNotMatch(row(messageId).from_addr, /[\r\n]/);
	assert.match(row(messageId).from_addr, /<team@example\.com>$/);
});

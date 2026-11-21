import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A forward rule without "keep a copy" only sends mail to the queue when the
// forward itself failed, so the queue must store it rather than drop it.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-failed-forward-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
		`,
		resolveDir: root,
		sourcefile: "failed-forward-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, intakeIncomingMail, processInboundMessage } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

const raw = new TextEncoder().encode("From: a@ext.test\r\nTo: x@one.test\r\nSubject: hi\r\nMessage-ID: <1@ext.test>\r\n\r\nbody\r\n").buffer;

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
		INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, action, forward_to, keep_copy, enabled, priority, created_at)
			VALUES ('r', 'admin', 'one', 'domain', 'box', '*', 'forward', 'team@elsewhere.test', 0, 1, 10, 1);
	`);
	const objects = new Map();
	const queued = [];
	const env = {
		DB: database,
		BUCKET: {
			put: async (key, value) => { objects.set(key, value); },
			get: async (key) => objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null,
			head: async (key) => objects.has(key) ? {} : null,
			delete: async (key) => { objects.delete(key); },
		},
		INBOUND_QUEUE: { send: async (payload) => { queued.push(payload); } },
	};
	return { env, database, objects, queued };
}

test("a catch-all forward that failed is stored in the catch-all mailbox", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	const result = await intakeIncomingMail(env, { from: "a@ext.test", to: "x@one.test", raw, headers: {} }, { forward: async () => false });
	assert.equal(result.action, "store");
	assert.equal(queued.length, 1);

	await processInboundMessage(env, queued[0]);
	const rows = database.db.prepare("SELECT mailbox_id, subject FROM messages").all();
	assert.deepEqual(rows.map((row) => ({ ...row })), [{ mailbox_id: "box", subject: "hi" }]);
});

test("a forward that went through is not queued, so nothing is stored", async (t) => {
	const { env, queued } = await setup(t);
	const result = await intakeIncomingMail(env, { from: "a@ext.test", to: "x@one.test", raw, headers: {} }, { forward: async () => true });
	assert.equal(result.action, "forward");
	assert.equal(queued.length, 0);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-webhook-dispatch-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { dispatchWebhooks, processWebhookRetry } from "./src/lib/email/webhooks.ts";
		`,
		resolveDir: root,
		sourcefile: "webhook-dispatch-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "mocks",
		setup(builder) {
			// Answer the endpoint's DNS lookup with a public address instead of asking DoH.
			builder.onResolve({ filter: /^@\/lib\/dns-query$/ }, () => ({ path: "dns", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ loader: "js", contents: `export async function queryDns(name, type) { return type === "A" ? ["93.184.216.34"] : []; }` }));
		},
	}],
});
const { SqliteDatabase, applyMigrations, dispatchWebhooks, processWebhookRetry } = await import(pathToFileURL(join(directory, "entry.mjs")).href);


async function setup(t, { fetchDelayMs = 0, failQueueFor = () => false } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES
			('h1', 'admin', 'https://one.example.com/in', 's', '["message.inbound"]', 1, 5, 1),
			('h2', 'admin', 'https://two.example.com/in', 's', '["message.inbound"]', 1, 5, 1),
			('h3', 'admin', 'https://three.example.com/in', 's', '["message.inbound"]', 1, 5, 1),
			('h4', 'admin', 'https://off.example.com/in', 's', '["message.inbound"]', 0, 5, 1),
			('h5', 'admin', 'https://other.example.com/in', 's', '["message.outbound"]', 1, 5, 1);
	`);
	const scheduled = [];
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		calls.push({ url: String(url), attempt: init.headers["X-Email-Platform-Attempt"] });
		if (fetchDelayMs) await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
		return new Response("ok", { status: 200 });
	});
	const hookOf = (deliveryId) => database.db.prepare("SELECT webhook_id FROM webhook_deliveries WHERE id = ?").get(deliveryId)?.webhook_id;
	const env = {
		DB: database,
		OUTBOUND_QUEUE: { send: async (message) => {
			if (failQueueFor(hookOf(message.deliveryId))) throw new Error("queue down");
			scheduled.push(message);
		} },
	};
	const rows = () => database.db.prepare("SELECT id, webhook_id, status, attempts, next_retry_at FROM webhook_deliveries ORDER BY webhook_id").all();
	return { env, scheduled, calls, rows };
}

test("dispatch only enqueues the first attempts", async (t) => {
	const { env, scheduled, calls, rows } = await setup(t);
	await dispatchWebhooks(env, "admin", "message.inbound", { messageId: "m1" });
	assert.equal(calls.length, 0);
	const stored = rows();
	assert.deepEqual(stored.map((row) => row.webhook_id), ["h1", "h2", "h3"]);
	for (const row of stored) {
		assert.equal(row.status, "retrying");
		assert.equal(row.attempts, 0);
		assert.ok(row.next_retry_at);
	}
	assert.deepEqual(scheduled.map((m) => m.deliveryId).sort(), stored.map((row) => row.id).sort());
	assert.ok(scheduled.every((m) => m.kind === "webhook.retry"));
});

test("a queued first attempt posts as attempt 1", async (t) => {
	const { env, scheduled, calls } = await setup(t);
	await dispatchWebhooks(env, "admin", "message.inbound", {});
	await processWebhookRetry(env, scheduled[0]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].attempt, "1");
});

test("a queue failure falls back to an inline attempt", async (t) => {
	const { env, scheduled, calls } = await setup(t, { failQueueFor: (hookId) => hookId === "h2" });
	await dispatchWebhooks(env, "admin", "message.inbound", {});
	assert.deepEqual(calls.map((call) => call.url), ["https://two.example.com/in"]);
	assert.equal(scheduled.length, 2);
});

test("dispatch does not wait on endpoints one after another", async (t) => {
	const { env } = await setup(t, { fetchDelayMs: 50, failQueueFor: () => true });
	const started = performance.now();
	await dispatchWebhooks(env, "admin", "message.inbound", {});
	assert.ok(performance.now() - started < 140, `took ${performance.now() - started}ms`);
});

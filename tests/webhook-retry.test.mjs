import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-webhook-retry-path-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getRetryDelaySeconds, processWebhookRetry, runDelivery } from "./src/lib/email/webhooks.ts";
			export { PUBLIC_HTTPS_URL_MESSAGE } from "./src/lib/security/public-url.ts";
		`,
		resolveDir: root,
		sourcefile: "webhook-retry-path-entry.ts",
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
			// Answer the endpoint's DNS lookup instead of asking DoH: internal.example.com is private, every other name is public.
			builder.onResolve({ filter: /^@\/lib\/dns-query$/ }, () => ({ path: "dns", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ loader: "js", contents: `export async function queryDns(name, type) { return type === "A" ? [name === "internal.example.com" ? "10.0.0.1" : "93.184.216.34"] : []; }` }));
		},
	}],
});
const { SqliteDatabase, applyMigrations, getRetryDelaySeconds, processWebhookRetry, runDelivery, PUBLIC_HTTPS_URL_MESSAGE } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function setup(t, { attempts = 1, maxAttempts = 5, url = "https://hooks.example.com/in", respond = () => new Response("down", { status: 500 }) } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1)").run();
	database.db.prepare("INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES ('hook', 'admin', ?, 'secret', 'message.inbound', 1, ?, 1)").run(url, maxAttempts);
	database.db.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempts, next_retry_at, created_at) VALUES ('d', 'hook', 'message.inbound', '{}', 'retrying', ?, 2, 1)").run(attempts);
	const queued = [];
	const posted = [];
	t.mock.method(globalThis, "fetch", async (target, init) => { posted.push({ url: String(target), init }); return respond(); });
	const env = { DB: database, OUTBOUND_QUEUE: { send: async (message, options) => { queued.push({ message, options }); } } };
	const delivery = () => database.db.prepare("SELECT status, attempts, error, next_retry_at FROM webhook_deliveries WHERE id = 'd'").get();
	return { env, queued, posted, delivery };
}

test("getRetryDelaySeconds doubles from one minute and caps at one hour", () => {
	assert.deepEqual([0, 1, 2, 3, 7, 12].map(getRetryDelaySeconds), [60, 60, 120, 240, 3600, 3600]);
});

test("a failing retry records retrying, counts the attempt and queues the next retry with backoff", async (t) => {
	const { env, queued, delivery } = await setup(t);
	await processWebhookRetry(env, { kind: "webhook.retry", deliveryId: "d" });
	const row = delivery();
	assert.equal(row.status, "retrying");
	assert.equal(row.attempts, 2);
	assert.equal(row.error, "down");
	assert.notEqual(row.next_retry_at, null);
	assert.deepEqual(queued, [{ message: { kind: "webhook.retry", deliveryId: "d" }, options: { delaySeconds: 120 } }]);
});

test("a successful retry marks delivered and queues nothing", async (t) => {
	const { env, queued, posted, delivery } = await setup(t, { respond: () => new Response("ok", { status: 200 }) });
	await processWebhookRetry(env, { kind: "webhook.retry", deliveryId: "d" });
	assert.deepEqual({ ...delivery() }, { status: "delivered", attempts: 2, error: null, next_retry_at: null });
	assert.deepEqual(queued, []);
	assert.equal(posted.length, 1);
	const headers = posted[0].init.headers;
	assert.equal(headers["X-Email-Platform-Attempt"], "2");
	assert.equal(headers["X-Email-Platform-Delivery"], "d");
	assert.match(headers["X-Email-Platform-Signature"], /^[0-9a-f]{64}$/);
});

test("reaching max_attempts ends exhausted and queues nothing", async (t) => {
	const { env, queued, delivery } = await setup(t, { maxAttempts: 2 });
	await processWebhookRetry(env, { kind: "webhook.retry", deliveryId: "d" });
	assert.deepEqual({ ...delivery() }, { status: "exhausted", attempts: 2, error: "down", next_retry_at: null });
	assert.deepEqual(queued, []);
});

test("runDelivery returns null for an unknown delivery and for another user's webhook", async (t) => {
	const { env, posted } = await setup(t);
	assert.equal(await runDelivery(env, "missing"), null);
	assert.equal(await runDelivery(env, "d", { userId: "someone-else" }), null);
	assert.deepEqual(posted, []);
});

// Each URL is stopped by a different check: scheme, IP literal, and what the name resolves to.
for (const [why, url] of [["plain http", "http://127.0.0.1/in"], ["an https IP literal (a public one, so only the literal check applies)", "https://93.184.216.34/in"], ["a name that resolves to a private address", "https://internal.example.com/in"]]) {
	test(`a non-public endpoint is refused without posting: ${why}`, async (t) => {
		const { env, posted, delivery } = await setup(t, { url });
		await processWebhookRetry(env, { kind: "webhook.retry", deliveryId: "d" });
		assert.equal(delivery().error, PUBLIC_HTTPS_URL_MESSAGE);
		assert.deepEqual(posted, []);
	});
}

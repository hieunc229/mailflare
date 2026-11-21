import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-webhook-retry-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { processWebhookRetry, runDelivery } from "./src/lib/email/webhooks.ts";
		`,
		resolveDir: root,
		sourcefile: "webhook-retry-entry.ts",
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
const { SqliteDatabase, applyMigrations, processWebhookRetry, runDelivery } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at)
			VALUES ('hook', 'admin', 'https://hooks.example.com/in', 'secret', 'message.inbound', 0, 5, 1);
		INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempts, next_retry_at, created_at)
			VALUES ('d', 'hook', 'message.inbound', '{}', 'retrying', 1, 2, 1);
	`);
	const scheduled = [];
	const posted = [];
	t.mock.method(globalThis, "fetch", async (url) => { posted.push(String(url)); return new Response("down", { status: 500 }); });
	const env = { DB: database, OUTBOUND_QUEUE: { send: async (message) => { scheduled.push(message); } } };
	const delivery = () => database.db.prepare("SELECT status, attempts, error, next_retry_at FROM webhook_deliveries WHERE id = 'd'").get();
	return { env, scheduled, posted, delivery };
}

test("a queued retry for a disabled webhook does not post and schedules nothing", async (t) => {
	const { env, scheduled, posted, delivery } = await setup(t);
	await processWebhookRetry(env, { kind: "webhook.retry", deliveryId: "d" });
	assert.deepEqual(posted, []);
	assert.deepEqual(scheduled, []);
	assert.deepEqual({ ...delivery() }, { status: "failed", attempts: 1, error: "Webhook is disabled", next_retry_at: null });
});

test("the manual retry button still runs a delivery of a disabled webhook", async (t) => {
	const { env, posted } = await setup(t);
	const result = await runDelivery(env, "d", { userId: "admin" });
	assert.deepEqual(posted, ["https://hooks.example.com/in"]);
	assert.equal(result.status, "retrying");
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.whEnv}",
	"@/lib/api/auth": 'export async function requireSessionUser(){return {user:{id:"u1",role:"admin",isPrimaryAdmin:true},error:null}}',
};
const { app, newDatabase } = await loadApp("webhook-retention", `
	export { purgeOldWebhookDeliveries } from "./src/lib/email/webhook-retention.ts";
	export * as route from "./src/app/api/webhooks/route.ts";
`, { mocks });

const now = new Date("2026-06-30T00:00:00Z");
const sec = now.getTime() / 1000;
const old = sec - 31 * 86400;
const recent = sec - 29 * 86400;
const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.com', 'h', 'U', 'admin', 1);
	INSERT INTO webhooks (id, user_id, url, secret, events, created_at) VALUES ('wh1', 'u1', 'https://example.com/h', 's', '[]', 1);
`;
const insert = (sqlite, id, status, at) => sqlite.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, created_at) VALUES (?, 'wh1', 'e', '{}', ?, ?)").run(id, status, at);

test("deletes finished rows older than 30 days only", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	for (const [id, status, at] of [["old-delivered", "delivered", old], ["old-failed", "failed", old], ["old-exhausted", "exhausted", old], ["old-retrying", "retrying", old], ["old-pending", "pending", old], ["new-delivered", "delivered", recent]]) insert(sqlite, id, status, at);
	assert.equal(await app.purgeOldWebhookDeliveries(env, now), 3);
	assert.deepEqual(sqlite.prepare("SELECT id FROM webhook_deliveries ORDER BY id").all().map((r) => r.id), ["new-delivered", "old-pending", "old-retrying"]);
});

test("clears a backlog larger than one batch", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	for (let i = 0; i < 200; i += 1) insert(sqlite, `d${i}`, "delivered", old);
	assert.equal(await app.purgeOldWebhookDeliveries(env, now), 200);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM webhook_deliveries").get().n, 0);
});

test("GET /api/webhooks counts only the last 30 days", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	const real = Date.now() / 1000;
	insert(sqlite, "r1", "delivered", real - 86400);
	insert(sqlite, "o1", "delivered", real - 40 * 86400);
	insert(sqlite, "o2", "delivered", real - 40 * 86400);
	globalThis.whEnv = env;
	const body = await (await app.route.GET(new Request("http://localhost/api/webhooks"))).json();
	assert.equal(body.webhooks[0].stats.total, 1);
	assert.equal(body.webhooks[0].stats.delivered, 1);
});

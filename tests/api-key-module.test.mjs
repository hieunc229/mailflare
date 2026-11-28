import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const mocks = { "@/lib/auth/activity": "export async function recordAuthActivity(env, input){ globalThis.keyActivity.push(input.action) }" };
const { app, newDatabase } = await loadApp("api-key-module", 'export { insertApiKeyRow, revokeApiKey } from "./src/lib/api-key-store.ts";', { mocks });

const seed = `${sharedMailboxSeed("read_only")}
	INSERT INTO api_keys (id, user_id, kind, name, prefix, key_hash, key_sha256, scopes, created_at) VALUES
		('k-app', 'admin', 'app', 'phone', 'p', 'h', 's1', '["imap"]', 1),
		('k-dev', 'admin', 'device', 'dev', 'p', 'h', 's2', '["x"]', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('m1', 'admin', 'mb-admin', 'outbound', 'a@example.com', 'b@example.com', 's', 'draft', 1);
	INSERT INTO agent_send_approvals (id, draft_id, mailbox_id, user_id, request_key_id, revision, payload_hash, status, expires_at, created_at) VALUES ('ap1', 'm1', 'mb-admin', 'admin', 'k-app', 1, 'x', 'pending', 9999999999, 1);`;
const request = new Request("http://localhost/x");

test("revoking an app password cancels approvals, deletes it and records activity", async (t) => {
	const { db, env, sqlite } = await newDatabase(t, seed);
	globalThis.keyActivity = [];
	await app.revokeApiKey(db, env, { id: "k-app", userId: "admin", kind: "app", scopes: '["imap"]', request });
	assert.deepEqual(globalThis.keyActivity, ["auth.app_password_revoked"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM api_keys WHERE id = 'k-app'").get().n, 0);
	assert.equal(sqlite.prepare("SELECT status FROM agent_send_approvals WHERE id = 'ap1'").get().status, "cancelled");
});

test("revoking a key that is not an app password records nothing", async (t) => {
	const { db, env, sqlite } = await newDatabase(t, seed);
	globalThis.keyActivity = [];
	await app.revokeApiKey(db, env, { id: "k-dev", userId: "admin", kind: "device", scopes: '["x"]', request });
	assert.deepEqual(globalThis.keyActivity, []);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM api_keys WHERE id = 'k-dev'").get().n, 0);
});

test("insertApiKeyRow writes one key and one scope row per mailbox", async (t) => {
	const { db, sqlite } = await newDatabase(t, seed);
	const row = (id) => ({ id, userId: "admin", name: "n", prefix: "p", keyHash: "h", keySha256: `s-${id}`, scopes: "[]" });
	await app.insertApiKeyRow(db, row("k1"), ["mb-admin", "mb-team"]);
	await app.insertApiKeyRow(db, row("k2"), []);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mcp_key_mailboxes WHERE key_id = 'k1'").get().n, 2);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mcp_key_mailboxes WHERE key_id = 'k2'").get().n, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM api_keys WHERE id IN ('k1','k2')").get().n, 2);
});

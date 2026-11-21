import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("admin-key-demotion", `
	export { adminApiKeyRevocations } from "./src/lib/api/admin-key-revocation.ts";
	export { generateApiKey } from "./src/lib/api-keys.ts";
`);

async function seed(t) {
	const fixture = await newDatabase(t, `
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('old', 'old@example.com', 'x', 'Old', 'admin', 1, 1),
			('new', 'new@example.com', 'x', 'New', 'admin', 0, 1);
	`);
	const keys = {};
	for (const [id, userId, scopes] of [["k-admin", "old", '["domains","accounts"]'], ["k-mixed", "old", '["read","storage"]'], ["k-mail", "old", '["read","send"]'], ["k-other", "new", '["domains"]']]) {
		const key = await app.generateApiKey();
		keys[id] = key.fullKey;
		fixture.sqlite.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, key_sha256, scopes, mailbox_scope_enabled, created_at) VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, 0, 1)").run(id, userId, id, key.prefix, key.hash, key.sha256, scopes);
	}
	return { ...fixture, keys };
}

test("transferring the primary role revokes the old primary's admin keys only", async (t) => {
	const { db, sqlite } = await seed(t);
	await db.batch(await app.adminApiKeyRevocations(db, "old"));
	const left = sqlite.prepare("SELECT id FROM api_keys ORDER BY id").all().map((row) => row.id);
	assert.deepEqual(left, ["k-mail", "k-other"]);
});

test("the transfer route revokes inside the same batch as the role switch", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/app/api/accounts/[id]/transfer-primary/route.ts", import.meta.url), "utf8");
	assert.match(source, /adminApiKeyRevocations\(db, actor\.id\)/);
	assert.match(source, /\.\.\.revocations/);
});

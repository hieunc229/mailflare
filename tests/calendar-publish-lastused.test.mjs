import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "cal-pub-lastused", entryPoint: "src/lib/calendar/free-busy-link.ts", mocks: { "@/db": "export function getDb(){return globalThis.calPubUsed.db}" } });
const { authenticateFreeBusyKey } = await fixture.import();
const keyAuth = await loadFixture({ name: "cal-pub-keyauth", entryPoint: "src/lib/api/key-auth.ts", mocks: { "@/db": "export function getDb(){return globalThis.calPubUsed.db}" } });
const { authenticateApiKeyValue } = await keyAuth.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calPubUsed; fixture.dispose(); keyAuth.dispose(); });

const { createHash } = await import("node:crypto");
function setup() {
	sqlite?.close();
	sqlite = installSqlite("calPubUsed", { schema });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	const key = (secret, scopes) => sqlite.exec(`INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, scopes, created_at) VALUES ('k_${secret}', 'u1', 'k', 'ep_', 'x', '${createHash("sha256").update(secret).digest("hex")}', '${scopes}', 1)`);
	key("fb", '["calendar:freebusy"]');
	key("both", '["calendar:freebusy","calendar:read"]');
}
const used = (secret) => sqlite.prepare("SELECT last_used_at AS at FROM api_keys WHERE id = ?").get(`k_${secret}`).at;

test("a publish key refused because Calendar is off, or because it has other scopes too, is not recorded as used", async () => {
	setup();
	sqlite.exec("UPDATE users SET calendar_enabled = 0");
	assert.equal(await authenticateFreeBusyKey({}, "fb"), null);
	assert.equal(used("fb"), null);
	sqlite.exec("UPDATE users SET calendar_enabled = 1");
	assert.equal(await authenticateFreeBusyKey({}, "both"), null);
	assert.equal(used("both"), null);
});

test("a publish key that is accepted is recorded as used", async () => {
	setup();
	assert.deepEqual(Object.keys((await authenticateFreeBusyKey({}, "fb")) ?? {}).sort(), ["keyId", "userId"]);
	assert.ok(used("fb") > 0);
});

test("other callers of key auth are unchanged: a key is recorded as used whatever the owner's Calendar setting", async () => {
	setup();
	sqlite.exec("UPDATE users SET calendar_enabled = 0");
	assert.ok(await authenticateApiKeyValue({}, "both"));
	assert.ok(used("both") > 0);
});

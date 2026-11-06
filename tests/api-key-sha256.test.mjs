import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-api-key-sha256-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { generateApiKey, generateAppPassword, hashApiKey, timingSafeEqualText, verifyApiKey } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { authenticateApiKeyValue, authenticateApiRequest } from "./src/lib/api/key-auth.ts";
			export { authenticateMcpRequest } from "./src/lib/mcp/auth.ts";
			export { hashPassword, verifyPassword } from "./src/lib/auth/password.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "api-key-sha256-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const {
	generateApiKey,
	generateAppPassword,
	hashApiKey,
	timingSafeEqualText,
	verifyApiKey,
	clearApiKeyVerificationCache,
	authenticateApiKeyValue,
	authenticateApiRequest,
	authenticateMcpRequest,
	hashPassword,
	verifyPassword,
	SqliteDatabase,
	applyMigrations,
	getDb,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

async function createFixture(t) {
	clearApiKeyVerificationCache();
	const database = new SqliteDatabase(":memory:");
	t.after(() => {
		database.db.close();
		clearApiKeyVerificationCache();
	});
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'owner@one.test', 'Owner', 'x', 'admin', 1)").run();
	const env = { DB: database };
	return { database, env, db: getDb(env) };
}

function insertKey(database, { id, prefix, hash, sha256 = null, kind = "legacy", scopes = '["jmap"]' }) {
	database.db
		.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES (?, 'u1', 'key', ?, ?, ?, ?, ?, 1)")
		.run(id, prefix, hash, sha256, kind, scopes);
}

test("new API keys and app passwords are SHA-256, not bcrypt", async () => {
	const apiKey = await generateApiKey();
	const appPassword = await generateAppPassword();
	assert.equal(apiKey.fullKey.startsWith("ep_"), true);
	assert.equal(apiKey.prefix, apiKey.fullKey.slice(0, 12));
	assert.equal(apiKey.sha256, await hashApiKey(apiKey.fullKey));
	assert.equal(apiKey.hash, apiKey.sha256);
	assert.equal(verifyApiKey(apiKey.fullKey, apiKey.hash), false);
	assert.equal(appPassword.fullKey.length, 16);
	assert.equal(appPassword.prefix, appPassword.fullKey.slice(0, 6));
	assert.equal(appPassword.sha256, await hashApiKey(appPassword.fullKey));
	assert.equal(appPassword.hash, appPassword.sha256);
	assert.equal(timingSafeEqualText(apiKey.sha256, apiKey.sha256), true);
	assert.equal(timingSafeEqualText(apiKey.sha256, appPassword.sha256), false);
	assert.equal(timingSafeEqualText("abc", "abcd"), false);
});

test("account passwords stay on bcrypt", () => {
	const password = "correct horse battery";
	const hash = hashPassword(password);
	assert.match(hash, /^\$2[aby]\$12\$/);
	assert.equal(verifyPassword(password, hash), true);
	assert.equal(verifyPassword("wrong password", hash), false);
	assert.equal(verifyApiKey(password, hash), true);
});

test("SHA-256 keys authenticate without a bcrypt hash, including JMAP Basic auth", async (t) => {
	const { database, env } = await createFixture(t);
	const issued = await generateAppPassword();
	insertKey(database, { id: "app", prefix: issued.prefix, hash: "not-a-bcrypt-hash", sha256: issued.sha256 });
	const auth = await authenticateApiKeyValue(env, `  ${issued.fullKey}  `);
	assert.equal(auth?.keyId, "app");
	assert.equal(auth?.userId, "u1");
	assert.deepEqual(auth?.scopes, ["jmap"]);
	const basic = Buffer.from(`mobile:${issued.fullKey}`).toString("base64");
	const request = new Request("https://mail.example/jmap/api", { method: "POST", headers: { Authorization: `Basic ${basic}` } });
	assert.equal((await authenticateApiRequest(env, request))?.keyId, "app");
	assert.equal(await authenticateApiKeyValue(env, `${issued.fullKey}nope`), null);
	assert.equal(await authenticateApiRequest(env, new Request("https://mail.example/jmap/api", { headers: { Authorization: "Basic !!!" } })), null);
	const started = performance.now();
	for (let attempt = 0; attempt < 25; attempt += 1) assert.equal((await authenticateApiKeyValue(env, issued.fullKey))?.keyId, "app");
	const elapsed = performance.now() - started;
	assert.ok(elapsed < 400, `25 SHA-256 auths took ${elapsed.toFixed(0)}ms`);
});

test("a stored SHA-256 mismatch does not fall back to bcrypt", async (t) => {
	const { database, env } = await createFixture(t);
	const issued = await generateApiKey();
	insertKey(database, { id: "bad-hash", prefix: issued.prefix, hash: bcrypt.hashSync(issued.fullKey, 4), sha256: "0".repeat(64) });
	assert.equal(await authenticateApiKeyValue(env, issued.fullKey), null);
});

test("legacy bcrypt keys still authenticate and are upgraded in place", async (t) => {
	const { database, env } = await createFixture(t);
	const secret = "abcdefghij123456";
	insertKey(database, { id: "legacy", prefix: secret.slice(0, 6), hash: bcrypt.hashSync(secret, 4) });
	insertKey(database, { id: "other-legacy", prefix: "zzzzzz", hash: bcrypt.hashSync("zzzzzz0000000000", 4) });
	assert.equal(await authenticateApiKeyValue(env, "abcdefghij123457"), null);
	assert.equal(database.db.prepare("SELECT key_sha256 FROM api_keys WHERE id = 'legacy'").get().key_sha256, null);
	assert.equal((await authenticateApiKeyValue(env, secret))?.keyId, "legacy");
	assert.equal(database.db.prepare("SELECT key_sha256 FROM api_keys WHERE id = 'legacy'").get().key_sha256, await hashApiKey(secret));
	database.db.prepare("UPDATE api_keys SET key_hash = 'not-bcrypt' WHERE id = 'legacy'").run();
	clearApiKeyVerificationCache();
	assert.equal((await authenticateApiKeyValue(env, secret))?.keyId, "legacy");
});

test("replacing the stored hash drops a cached verification", async (t) => {
	const { database, env } = await createFixture(t);
	const issued = await generateApiKey();
	insertKey(database, { id: "cached", prefix: issued.prefix, hash: issued.hash, sha256: issued.sha256, kind: "device", scopes: '["jmap"]' });
	assert.equal((await authenticateApiKeyValue(env, issued.fullKey))?.keyKind, "device");
	database.db.prepare("UPDATE api_keys SET key_sha256 = ? WHERE id = 'cached'").run("f".repeat(64));
	assert.equal(await authenticateApiKeyValue(env, issued.fullKey), null);
	database.db.prepare("UPDATE api_keys SET key_sha256 = ? WHERE id = 'cached'").run(issued.sha256);
	assert.equal((await authenticateApiKeyValue(env, issued.fullKey))?.keyId, "cached");
});

test("disabled users and account passwords are rejected", async (t) => {
	const { database, env } = await createFixture(t);
	const issued = await generateApiKey();
	insertKey(database, { id: "live", prefix: issued.prefix, hash: issued.hash, sha256: issued.sha256 });
	database.db.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	assert.equal(await authenticateApiKeyValue(env, issued.fullKey), null);
	assert.equal(await authenticateApiKeyValue(env, "correct horse battery"), null);
	assert.equal(await authenticateApiKeyValue(env, ""), null);
});

test("MCP accepts only mcp keys and uses the same SHA-256 check", async (t) => {
	const { database, env } = await createFixture(t);
	const issued = await generateApiKey();
	insertKey(database, { id: "mcp", prefix: issued.prefix, hash: "not-a-bcrypt-hash", sha256: issued.sha256, kind: "mcp", scopes: '["mcp:read"]' });
	const request = new Request("https://mail.example/mcp", { headers: { Authorization: `Bearer ${issued.fullKey}` } });
	const principal = await authenticateMcpRequest(env, request);
	assert.equal(principal?.keyId, "mcp");
	assert.deepEqual(principal?.scopes, ["mcp:read"]);
	const appPassword = await generateAppPassword();
	insertKey(database, { id: "app", prefix: appPassword.prefix, hash: appPassword.hash, sha256: appPassword.sha256, scopes: '["mcp:read"]' });
	const appRequest = new Request("https://mail.example/mcp", { headers: { Authorization: `Bearer ${appPassword.fullKey}` } });
	assert.equal(await authenticateMcpRequest(env, appRequest), null);
	database.db.prepare("UPDATE api_keys SET kind = 'legacy' WHERE id = 'mcp'").run();
	clearApiKeyVerificationCache();
	assert.equal(await authenticateMcpRequest(env, request), null);
});

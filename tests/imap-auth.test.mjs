import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeHelpers, seedWorld } from "./helpers/imap-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-auth-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { authenticateImap, revalidateIdentity, clearLoginAuditMemory } from "./src/lib/imap/auth.ts";
			export { generateAppPassword, generateApiKey } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { openRateLimiter } from "./server/runtime/misc.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-auth-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { authenticateImap, revalidateIdentity, clearLoginAuditMemory, generateAppPassword, clearApiKeyVerificationCache, SqliteDatabase, applyMigrations, openRateLimiter } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function world(t, extraEnv = {}) {
	clearApiKeyVerificationCache();
	clearLoginAuditMemory();
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	seedWorld(database.db);
	return { sqlite: database.db, env: { DB: database, ...extraEnv }, ...makeHelpers(database.db, generateAppPassword) };
}
const login = (env, key, username, ip = "203.0.113.5") => authenticateImap(env, { username, secret: key.fullKey, ip, client: "TestMail" });

test("the login e-mail and an alias both name the primary mailbox's owner, other addresses need access", async (t) => {
	const { env, addKey } = await world(t);
	const key = await addKey({ id: "k1" });
	const primary = await login(env, key, "ME@Example.test");
	assert.equal(primary.ok, true);
	assert.equal(primary.identity.loginMailboxId, "m1");
	assert.equal(primary.identity.keyId, "k1");
	assert.equal(JSON.stringify(primary.identity).includes(key.fullKey), false, "the identity never holds the secret");
	assert.equal((await login(env, key, "second@example.test")).identity.loginMailboxId, "m1b");
	assert.equal((await login(env, key, "alias@example.test")).identity.loginMailboxId, "m1");
	assert.equal((await login(env, key, "team@other.test")).identity.loginMailboxId, "ms", "a delegated shared mailbox can be the account");
});

test("a spaced or dashed password typed from the grouped display works", async (t) => {
	const { env, addKey } = await world(t);
	const key = await addKey({ id: "k1" });
	const grouped = key.fullKey.match(/.{4}/g).join(" ");
	assert.equal((await authenticateImap(env, { username: "me@example.test", secret: grouped, ip: null, client: "x" })).ok, true);
});

test("every failure looks the same: wrong secret, other user's address, unknown address, missing scope, account password", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "k1" });
	const jmapOnly = await addKey({ id: "k2", scopes: ["jmap"] });
	const legacy = await addKey({ id: "k3", kind: "legacy", scopes: ["imap"] });
	const results = [
		await login(env, key, "two@other.test"),
		await login(env, key, "nobody@example.test"),
		await login(env, key, ""),
		await login(env, key, `${"a".repeat(400)}@example.test`),
		await login(env, jmapOnly, "me@example.test"),
		await login(env, legacy, "me@example.test"),
		await authenticateImap(env, { username: "me@example.test", secret: "not-the-password-at-all", ip: "198.51.100.1", client: "x" }),
		await authenticateImap(env, { username: "me@example.test", secret: "", ip: "198.51.100.1", client: "x" }),
	];
	// The caller is told one thing for all of them; the reason only goes to the log.
	assert.deepEqual(results.map((result) => (result.ok ? "ok" : result.reason)), ["no_mailbox", "no_mailbox", "no_mailbox", "no_mailbox", "bad_secret", "bad_secret", "bad_secret", "bad_secret"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM audit_logs").get().n, 0, "failed logins are not recorded as logins");
});

test("the account password is not accepted", async (t) => {
	const { env, sqlite } = await world(t);
	sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'u1'").run("$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234");
	assert.deepEqual(await authenticateImap(env, { username: "me@example.test", secret: "correct horse battery staple", ip: null, client: "x" }), { ok: false, reason: "bad_secret" });
});

test("a key limited to some mailboxes cannot log in as another, even one the user owns", async (t) => {
	const { env, addKey } = await world(t);
	const key = await addKey({ id: "k1", mailboxes: ["m1b"] });
	assert.deepEqual(await login(env, key, "me@example.test"), { ok: false, reason: "no_mailbox" }, "the primary mailbox is outside the scope");
	assert.deepEqual(await login(env, key, "team@other.test"), { ok: false, reason: "no_mailbox" });
	assert.equal((await login(env, key, "second@example.test")).ok, true);
});

test("a disabled user cannot log in", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "k1" });
	sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	assert.deepEqual(await login(env, key, "me@example.test"), { ok: false, reason: "bad_secret" });
});

test("guesses spend the shared per-address budget: the eleventh in a minute is refused, a known password still works", async (t) => {
	const { env, addKey } = await world(t, { DEVICE_LOGIN_RATE_LIMIT: openRateLimiter(10, 60) });
	const key = await addKey({ id: "k1" });
	const results = [];
	for (let attempt = 0; attempt < 12; attempt += 1) results.push((await authenticateImap(env, { username: "me@example.test", secret: `wrong-guess-number-${attempt}`, ip: "203.0.113.9", client: "x" })).reason);
	assert.deepEqual(results, [...Array(10).fill("bad_secret"), "throttled", "throttled"]);
	assert.equal((await login(env, key, "me@example.test", "203.0.113.9")).reason, "throttled", "the first genuine attempt from a spent address is a guess too");
	assert.equal((await login(env, key, "me@example.test", "203.0.113.77")).ok, true, "another address has its own budget");
	assert.equal((await login(env, key, "me@example.test", "203.0.113.9")).ok, true, "a password this process verified recently does not spend the budget");
});

test("a login is written to the audit log at most once an hour per key and address, with no secret in it", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "k1" });
	await login(env, key, "me@example.test");
	await login(env, key, "me@example.test");
	await login(env, key, "me@example.test", "198.51.100.4");
	const rows = sqlite.prepare("SELECT actor_user_id, target_user_id, mailbox_id, action, metadata FROM audit_logs ORDER BY rowid").all();
	assert.equal(rows.length, 2);
	assert.deepEqual({ ...rows[0], metadata: JSON.parse(rows[0].metadata) }, { actor_user_id: "u1", target_user_id: "u1", mailbox_id: "m1", action: "auth.app_password_login", metadata: { ipAddress: "203.0.113.5", device: "Mail app", platform: "TestMail", keyId: "k1" } });
	assert.equal(JSON.stringify(rows).includes(key.fullKey), false);
});

test("a session's login stands until the key is deleted, loses the imap scope, or its user is disabled", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "k1" });
	const { identity } = await login(env, key, "me@example.test");
	assert.equal((await revalidateIdentity(env, identity))?.keyId, "k1");

	sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'k1'").run(JSON.stringify(["jmap"]));
	assert.equal(await revalidateIdentity(env, identity), null, "scope removed");
	sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'k1'").run(JSON.stringify(["imap"]));
	assert.ok(await revalidateIdentity(env, identity));
	sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	assert.equal(await revalidateIdentity(env, identity), null, "user disabled");
	sqlite.prepare("UPDATE users SET disabled = 0 WHERE id = 'u1'").run();
	sqlite.prepare("DELETE FROM api_keys WHERE id = 'k1'").run();
	assert.equal(await revalidateIdentity(env, identity), null, "key revoked");
});

test("revalidation picks up a narrowed mailbox scope", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "k1" });
	const { identity } = await login(env, key, "me@example.test");
	assert.equal(identity.auth.mailboxIds, null);
	sqlite.prepare("UPDATE api_keys SET mailbox_scope_enabled = 1 WHERE id = 'k1'").run();
	sqlite.prepare("INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES ('k1', 'm1b')").run();
	assert.deepEqual((await revalidateIdentity(env, identity)).auth.mailboxIds, ["m1b"]);
});

test("a key row that now belongs to another user is not the same login", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "k1" });
	const { identity } = await login(env, key, "me@example.test");
	sqlite.prepare("UPDATE api_keys SET user_id = 'u2' WHERE id = 'k1'").run();
	assert.equal(await revalidateIdentity(env, identity), null);
});

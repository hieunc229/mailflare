import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeHelpers, seedWorld } from "./helpers/imap-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-submission-logic-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { authenticateImap, authenticateSubmission, revalidateIdentity, clearLoginAuditMemory } from "./src/lib/imap/auth.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { openRateLimiter } from "./server/runtime/misc.ts";
		`,
		resolveDir: root,
		sourcefile: "submission-logic-test-entry.ts",
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
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function world(t, extraEnv = {}) {
	m.clearApiKeyVerificationCache();
	m.clearLoginAuditMemory();
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	seedWorld(database.db);
	return { sqlite: database.db, env: { DB: database, ...extraEnv }, ...makeHelpers(database.db, m.generateAppPassword) };
}
const login = (env, key, username, ip = "203.0.113.5") => m.authenticateSubmission(env, { username, secret: key.fullKey, ip, client: "SMTP" });

test("a submission login needs an app password with the submission scope; an imap-only key does not work here and the reverse", async (t) => {
	const { env, addKey } = await world(t);
	const sending = await addKey({ id: "ks", scopes: ["submission"] });
	const reading = await addKey({ id: "ki", scopes: ["imap"] });
	const both = await addKey({ id: "kb", scopes: ["imap", "submission"] });
	assert.equal((await login(env, sending, "me@example.test")).ok, true);
	assert.deepEqual(await login(env, reading, "me@example.test"), { ok: false, reason: "bad_secret" });
	assert.equal((await login(env, both, "me@example.test")).ok, true);
	assert.deepEqual(await m.authenticateImap(env, { username: "me@example.test", secret: sending.fullKey, ip: null, client: "x" }), { ok: false, reason: "bad_secret" });
});

test("the username names a mailbox the user can access inside the key's scope, and every other case ends the same way", async (t) => {
	const { env, addKey } = await world(t);
	const key = await addKey({ id: "ks", scopes: ["submission"], mailboxes: ["m1b"] });
	assert.equal((await login(env, key, "SECOND@example.test")).identity.loginMailboxId, "m1b");
	for (const name of ["me@example.test", "team@other.test", "two@other.test", "", `${"a".repeat(400)}@example.test`]) assert.deepEqual(await login(env, key, name), { ok: false, reason: "no_mailbox" }, name);
});

test("guesses over submission and IMAP spend the same per-address budget", async (t) => {
	const { env, addKey } = await world(t, { DEVICE_LOGIN_RATE_LIMIT: m.openRateLimiter(10, 60) });
	const key = await addKey({ id: "ks", scopes: ["submission", "imap"] });
	const reasons = [];
	for (let attempt = 0; attempt < 6; attempt += 1) reasons.push((await m.authenticateImap(env, { username: "me@example.test", secret: `wrong-imap-guess-${attempt}`, ip: "203.0.113.9", client: "x" })).reason);
	for (let attempt = 0; attempt < 6; attempt += 1) reasons.push((await m.authenticateSubmission(env, { username: "me@example.test", secret: `wrong-smtp-guess-${attempt}`, ip: "203.0.113.9", client: "SMTP" })).reason);
	assert.deepEqual(reasons, [...Array(10).fill("bad_secret"), "throttled", "throttled"]);
	assert.equal((await login(env, key, "me@example.test", "203.0.113.9")).reason, "throttled");
	assert.equal((await login(env, key, "me@example.test", "203.0.113.77")).ok, true);
});

test("a submission login is audited as an SMTP login with the key id and no secret", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "ks", scopes: ["submission"] });
	await login(env, key, "me@example.test");
	const [row] = sqlite.prepare("SELECT action, metadata FROM audit_logs").all();
	assert.equal(row.action, "auth.app_password_login");
	assert.deepEqual(JSON.parse(row.metadata), { ipAddress: "203.0.113.5", device: "Mail app", platform: "SMTP", keyId: "ks" });
	assert.equal(row.metadata.includes(key.fullKey), false);
});

test("a submission session's login stands until the key is deleted, loses the submission scope, or its user is disabled", async (t) => {
	const { env, addKey, sqlite } = await world(t);
	const key = await addKey({ id: "ks", scopes: ["submission"] });
	const { identity } = await login(env, key, "me@example.test");
	assert.equal((await m.revalidateIdentity(env, identity, "submission"))?.keyId, "ks");
	assert.equal(await m.revalidateIdentity(env, identity), null, "the default protocol is imap, which this key does not carry");
	sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'ks'").run(JSON.stringify(["imap"]));
	assert.equal(await m.revalidateIdentity(env, identity, "submission"), null, "scope removed");
	sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'ks'").run(JSON.stringify(["submission"]));
	sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	assert.equal(await m.revalidateIdentity(env, identity, "submission"), null, "user disabled");
	sqlite.prepare("UPDATE users SET disabled = 0 WHERE id = 'u1'").run();
	sqlite.prepare("DELETE FROM api_keys WHERE id = 'ks'").run();
	assert.equal(await m.revalidateIdentity(env, identity, "submission"), null, "key deleted");
});

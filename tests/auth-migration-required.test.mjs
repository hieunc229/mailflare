import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-auth-migration-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
// completeLogin reads the request's cookie jar, which only exists inside Next's request scope.
const headersStub = join(directory, "next-headers-stub.mjs");
writeFileSync(headersStub, "export async function cookies() { return { get: () => undefined }; }\n");

// The auth routes run against a real in-memory SQLite database with the real migrations applied,
// so a missing column is a genuinely un-applied migration, not a mocked failure.
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { hashPassword } from "./src/lib/auth/password.ts";
			export { hashSessionToken } from "./src/lib/auth/session.ts";
			export { credentialIdHash } from "./src/lib/auth/webauthn/credentials.ts";
			export { createLoginChallenge } from "./src/lib/auth/login-challenge.ts";
			export { createCeremonyBinding, createWebAuthnChallenge } from "./src/lib/auth/webauthn/challenges.ts";
			export { migrationRequired } from "./src/lib/http/migration-required.ts";
			export * as login from "./src/app/api/auth/login/route.ts";
			export * as me from "./src/app/api/auth/me/route.ts";
			export * as devices from "./src/app/api/devices/route.ts";
			export * as mfaVerify from "./src/app/api/auth/mfa/verify/route.ts";
			export * as passkeyMfaOptions from "./src/app/api/auth/passkey/mfa/options/route.ts";
			export * as passkeyMfaVerify from "./src/app/api/auth/passkey/mfa/verify/route.ts";
			export * as passkeyVerify from "./src/app/api/auth/passkey/verify/route.ts";
			export * as device from "./src/app/api/auth/device/route.ts";
		`,
		resolveDir: root,
		sourcefile: "auth-migration-required-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": headersStub, "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const PASSWORD = "correct-horse";
const TOKEN = "sess_auth_migration_test";
const MIGRATION_REQUIRED = { error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" };

/**
 * A signed-in account on a migrated database. `behind` re-creates the one thing a deploy that is
 * behind on migrations looks like: the `users` row is missing a column a later migration adds
 * (`totp_last_step`, migration 0090), so every `select ... from users` the auth path makes throws
 * "no such column" exactly as it does on remote D1 before `db:migrate:remote`.
 */
async function fixture(t, { behind = true, disabled = false } = {}) {
	const database = new app.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await app.applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Date.now();
	database.db.prepare(
		`INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, disabled, created_at)
		 VALUES ('u', 'owner@example.test', ?, 'Owner', 'admin', 1, ?, 1)`,
	).run(app.hashPassword(PASSWORD), disabled ? 1 : 0);
	database.db.prepare(
		`INSERT INTO passkey_credentials (id, user_id, credential_id, credential_hash, public_key, counter, device_type, name, created_at)
		 VALUES ('pk', 'u', 'cred-1', ?, 'pk', 0, 'singleDevice', 'Laptop', 1)`,
	).run(await app.credentialIdHash("cred-1"));
	database.db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s', 'u', ?, ?, 1)")
		.run(await app.hashSessionToken(TOKEN), now + 86_400_000);
	if (behind) database.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");
	const env = { DB: database, MAILFLARE_RUNTIME: "node", APP_URL: "https://mail.test" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return { database, env };
}

const post = (path, body, extraHeaders = {}) =>
	new Request(`https://mail.test${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "https://mail.test", ...extraHeaders },
		body: JSON.stringify(body),
	});
const get = (path) => new Request(`https://mail.test${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
const result = async (response) => ({ status: response.status, body: await response.json(), cookie: response.headers.get("Set-Cookie") });

test("a migration-behind database answers every auth entry point with MIGRATION_REQUIRED, not a 500", async (t) => {
	const { database, env } = await fixture(t);
	const challengeToken = await app.createLoginChallenge(env, "u");

	const password = await result(await app.login.POST(post("/api/auth/login", { email: "owner@example.test", password: PASSWORD })));
	assert.equal(password.status, 409);
	assert.deepEqual(password.body, MIGRATION_REQUIRED);
	// Fail closed: no session token and no cookie, so the refusal cannot sign anyone in.
	assert.equal(password.cookie, null);
	assert.equal(password.body.token, undefined);

	const mobile = await result(await app.device.POST(post("/api/auth/device", { email: "owner@example.test", password: PASSWORD, deviceName: "Phone" })));
	assert.equal(mobile.status, 409);
	assert.deepEqual(mobile.body, MIGRATION_REQUIRED);
	assert.equal(mobile.body.key, undefined);

	const secondFactor = await result(await app.mfaVerify.POST(post("/api/auth/mfa/verify", { challengeToken, code: "123456" })));
	assert.equal(secondFactor.status, 409);
	assert.deepEqual(secondFactor.body, MIGRATION_REQUIRED);

	const passkeyMfa = await result(await app.passkeyMfaOptions.POST(post("/api/auth/passkey/mfa/options", { challengeToken })));
	assert.equal(passkeyMfa.status, 409);
	assert.deepEqual(passkeyMfa.body, MIGRATION_REQUIRED);

	// The passkey second factor binds its ceremony to the login challenge, so the binding carries it.
	const mfaBinding = `${app.createCeremonyBinding()}:${challengeToken}`;
	const passkeyMfaVerify = await result(await app.passkeyMfaVerify.POST(post("/api/auth/passkey/mfa/verify", {
		challengeToken,
		ceremonyToken: "wac_unused",
		response: { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "e30", signature: "e30" } },
	}, { Cookie: `ep_webauthn=${encodeURIComponent(mfaBinding)}` })));
	assert.equal(passkeyMfaVerify.status, 409);
	assert.deepEqual(passkeyMfaVerify.body, MIGRATION_REQUIRED);

	// The session probe and every route that authenticates through `requireSessionUser`.
	const session = await result(await app.me.GET(get("/api/auth/me")));
	assert.equal(session.status, 409);
	assert.deepEqual(session.body, MIGRATION_REQUIRED);
	const sessionRoute = await result(await app.devices.GET(get("/api/devices")));
	assert.equal(sessionRoute.status, 409);
	assert.deepEqual(sessionRoute.body, MIGRATION_REQUIRED);

	// The passkey ceremony: this used to answer 401 "This passkey could not be verified".
	const binding = app.createCeremonyBinding();
	const { ceremonyToken } = await app.createWebAuthnChallenge(env, { challenge: "chal", purpose: "login", binding });
	const passkey = await result(await app.passkeyVerify.POST(post("/api/auth/passkey/verify", {
		ceremonyToken,
		response: { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "e30", signature: "e30" } },
	}, { Cookie: `ep_webauthn=${encodeURIComponent(binding)}` })));
	assert.equal(passkey.status, 409);
	assert.deepEqual(passkey.body, MIGRATION_REQUIRED);

	// Nothing above may have minted a session beyond the one the fixture seeded.
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
});

test("a missing users table is the same answer, and other errors are still rethrown", async (t) => {
	const { database } = await fixture(t);
	database.db.exec("DROP TABLE sessions");
	const session = await result(await app.me.GET(get("/api/auth/me")));
	assert.equal(session.status, 409);
	assert.deepEqual(session.body, MIGRATION_REQUIRED);

	assert.throws(() => app.migrationRequired(new Error("database is locked")), /database is locked/);
});

test("a migrated database signs in and keeps its own auth errors", async (t) => {
	const { database } = await fixture(t, { behind: false });
	const signedIn = await result(await app.login.POST(post("/api/auth/login", { email: "owner@example.test", password: PASSWORD })));
	assert.equal(signedIn.status, 200);
	assert.equal(signedIn.body.ok, true);
	assert.ok(signedIn.cookie?.includes("ep_session="));
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM sessions").get().n, 2);

	const session = await result(await app.me.GET(get("/api/auth/me")));
	assert.equal(session.status, 200);
	assert.equal(session.body.user.id, "u");

	const wrongPassword = await result(await app.login.POST(post("/api/auth/login", { email: "owner@example.test", password: "wrong" })));
	assert.equal(wrongPassword.status, 401);
	assert.equal(wrongPassword.body.code, "invalid_credentials");
});

test("a disabled account still gets account_disabled, not a migration error", async (t) => {
	await fixture(t, { behind: false, disabled: true });
	const login = await result(await app.login.POST(post("/api/auth/login", { email: "owner@example.test", password: PASSWORD })));
	assert.equal(login.status, 403);
	assert.equal(login.body.code, "account_disabled");
});

test("no bearer token is still a plain 401", async (t) => {
	await fixture(t, { behind: false });
	const response = await app.me.GET(new Request("https://mail.test/api/auth/me"));
	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

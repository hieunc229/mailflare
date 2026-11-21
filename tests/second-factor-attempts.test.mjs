import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "second-factor-attempts-"));
after(() => rmSync(directory, { recursive: true, force: true }));
// completeLogin reads the request's cookie jar, which only exists inside Next's request scope.
const headersStub = join(directory, "next-headers-stub.mjs");
writeFileSync(headersStub, "export async function cookies() { return { get: () => undefined }; }\n");
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createLoginChallenge } from "./src/lib/auth/login-challenge.ts";
			export { generateTotpSecret, hotp, totpCounter } from "./src/lib/auth/totp.ts";
			export * as mfaVerify from "./src/app/api/auth/mfa/verify/route.ts";
			export * as device from "./src/app/api/auth/device/route.ts";
		`,
		resolveDir: root,
		sourcefile: "second-factor-attempts-entry.ts",
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
const { SqliteDatabase, applyMigrations, createLoginChallenge, generateTotpSecret, hotp, totpCounter, mfaVerify, device } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

// No LOGIN_RATE_LIMIT binding: the per-IP limiter allows everything, as it does for an attacker spread over many IPs.
async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const secret = generateTotpSecret();
	database.db.prepare(`INSERT INTO users
		(id, email, password_hash, name, role, is_primary_admin, can_manage_users, can_manage_mailboxes, totp_secret, totp_enabled, require_second_factor, created_at)
		VALUES ('alice', 'alice@one.test', 'hash', 'Alice', 'user', 0, 0, 0, ?, 1, 1, 1)`).run(secret);
	const env = { DB: database, MAILFLARE_RUNTIME: "node", APP_URL: "https://mail.test" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const counter = totpCounter();
	const valid = new Set(await Promise.all([counter - 1, counter, counter + 1].map((step) => hotp(secret, step))));
	const goodCode = await hotp(secret, counter);
	const wrongCode = ["000000", "111111", "222222", "333333"].find((code) => !valid.has(code));
	const post = (path, body) => new Request(`https://mail.test${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "https://mail.test" },
		body: JSON.stringify(body),
	});
	return {
		goodCode,
		wrongCode,
		challenge: () => createLoginChallenge(env, "alice"),
		verify: (challengeToken, code) => mfaVerify.POST(post("/api/auth/mfa/verify", { challengeToken, code })),
		deviceVerify: (challengeToken, code) => device.POST(post("/api/auth/device", { challengeToken, code, deviceName: "Phone" })),
	};
}

test("a correct code still signs in after a few wrong ones", async t => {
	const f = await fixture(t);
	const challenge = await f.challenge();
	for (let index = 0; index < 4; index++) assert.equal((await f.verify(challenge, f.wrongCode)).status, 401);
	assert.equal((await f.verify(challenge, f.goodCode)).status, 200);
});

test("wrong codes are limited per account, across challenges and both sign-in routes", async t => {
	const f = await fixture(t);
	for (let index = 0; index < 3; index++) assert.equal((await f.verify(await f.challenge(), f.wrongCode)).status, 401);
	for (let index = 0; index < 2; index++) assert.equal((await f.deviceVerify(await f.challenge(), f.wrongCode)).status, 401);
	assert.equal((await f.verify(await f.challenge(), f.goodCode)).status, 429);
	assert.equal((await f.deviceVerify(await f.challenge(), f.goodCode)).status, 429);
});

test("parallel guesses cannot outrun the per-account limit", async t => {
	const f = await fixture(t);
	const challenge = await f.challenge();
	const statuses = await Promise.all(Array.from({ length: 12 }, () => f.verify(challenge, f.wrongCode).then((response) => response.status)));
	const checked = statuses.filter((status) => status === 401).length;
	assert.ok(checked >= 1 && checked <= 5, `${checked} codes were checked`);
	assert.equal(checked + statuses.filter((status) => status === 429).length, 12);
});

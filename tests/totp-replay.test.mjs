import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("totp-replay", `
	export { verifySecondFactor, confirmMfaEnrollment, disableMfa } from "./src/lib/auth/mfa.ts";
	export { totp, totpCounter } from "./src/lib/auth/totp.ts";
	export { users } from "./src/db/schema/index.ts";
`);

const SECRET = "JBSWY3DPEHPK3PXP";
const T0 = 1_800_000_030_000; // start of a 30 s step
const seed = `INSERT INTO users (id, email, password_hash, name, role, totp_secret, totp_enabled, created_at) VALUES ('u1', 'u1@example.com', 'hash', 'U', 'user', '${SECRET}', 1, 1);`;
const user = { id: "u1", totpSecret: SECRET, totpEnabled: true };
const at = (t, ms) => t.mock.method(Date, "now", () => ms);
const code = (ms) => app.totp(SECRET, ms);

test("a TOTP code works once and is refused when replayed in its window", async (t) => {
	const { env } = await newDatabase(t, seed);
	at(t, T0);
	const c = await code(T0);
	assert.equal(await app.verifySecondFactor(env, user, c), "totp");
	assert.equal(await app.verifySecondFactor(env, user, c), null);
	at(t, T0 + 25_000);
	assert.equal(await app.verifySecondFactor(env, user, c), null, "still inside the window");
});

test("only one of two concurrent uses of the same code succeeds", async (t) => {
	const { env } = await newDatabase(t, seed);
	at(t, T0);
	const c = await code(T0);
	const results = await Promise.all([app.verifySecondFactor(env, user, c), app.verifySecondFactor(env, user, c), app.verifySecondFactor(env, user, c)]);
	assert.deepEqual(results.filter(Boolean), ["totp"]);
});

test("a step at or below the last used one is refused, a later step is accepted", async (t) => {
	const { env } = await newDatabase(t, seed);
	at(t, T0);
	assert.equal(await app.verifySecondFactor(env, user, await code(T0)), "totp");
	assert.equal(await app.verifySecondFactor(env, user, await code(T0 - 30_000)), null, "earlier step in the skew window");
	assert.equal(await app.verifySecondFactor(env, user, await code(T0 + 30_000)), "totp", "next step");
	assert.equal(await app.verifySecondFactor(env, user, await code(T0)), null, "now behind the last used step");
});

test("the accepted step is stored", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	at(t, T0);
	const before = sqlite.prepare("SELECT totp_last_step AS s FROM users WHERE id = 'u1'").get().s;
	assert.equal(before ?? null, null);
	assert.equal(await app.verifySecondFactor(env, user, await code(T0)), "totp");
	assert.equal(sqlite.prepare("SELECT totp_last_step AS s FROM users WHERE id = 'u1'").get().s, app.totpCounter(T0));
});

test("the code that confirmed enrolment cannot sign in afterwards", async (t) => {
	const { env } = await newDatabase(t, seed.replace(", 1, 1);", ", 0, 1);"));
	at(t, T0);
	const c = await code(T0);
	const confirmed = await app.confirmMfaEnrollment(env, { id: "u1", totpSecret: SECRET, totpEnabled: false }, c);
	assert.equal(confirmed.ok, true);
	assert.equal(await app.verifySecondFactor(env, user, c), null);
	assert.equal(await app.verifySecondFactor(env, user, await code(T0 + 30_000)), "totp");
});

test("turning TOTP off clears the stored step", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	at(t, T0);
	await app.verifySecondFactor(env, user, await code(T0));
	await app.disableMfa(env, "u1");
	assert.equal(sqlite.prepare("SELECT totp_last_step AS s FROM users WHERE id = 'u1'").get().s, null);
});

// Login MFA, step-up, device sign-in and passkey-gated flows all go through verifySecondFactor,
// so only mfa.ts may match a code, and it records the step.
test("no route verifies a TOTP code without recording its step", () => {
	const hits = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.tsx?$/.test(name) && /\b(verifyTotp|matchTotpStep)\(/.test(readFileSync(path, "utf8"))) hits.push(path);
		}
	};
	walk(new URL("../src", import.meta.url).pathname);
	assert.deepEqual(hits.map((p) => p.split("/src/")[1]), ["lib/auth/mfa.ts", "lib/auth/totp.ts"]);
});

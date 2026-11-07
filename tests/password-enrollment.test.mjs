import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture, sqliteProxy } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({
	name: "password-enrollment",
	entryPoint: "src/app/api/settings/password/route.ts",
	mocks: {
		"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
		"@/db": "export function getDb(){return globalThis.passwordTest.db}",
		"@/lib/cloudflare": "export function getEnv(){return {}}",
		"@/lib/auth/cookies": "export async function requireUser(){return globalThis.passwordTest.user}",
		"@/lib/auth/session": "export function getSessionTokenFromRequestHeaders(){return 'session'} export async function deleteUserSessions(){}",
		"@/lib/auth/password": "export const PASSWORDLESS_PASSWORD_HASH='!passkey-only'; export function hasPasswordHash(value){return value!=='!passkey-only'} export function hashPassword(value){return 'hashed-'+value} export function verifyPassword(){return false}",
		"@/lib/auth/webauthn/grants": "export async function consumeStepUpGrant(){return globalThis.passwordTest.consume()} export async function bumpSecurityVersion(){globalThis.passwordTest.sqlite.exec('UPDATE users SET security_version=security_version+1')}",
		"@/lib/auth/webauthn/credentials": "export async function countPasskeys(){return 1}",
		"@/lib/auth/activity": "export async function recordAuthActivity(){}",
		"./utils": "export async function parseChangePasswordRequest(){throw new Error('Unused')}",
	},
});
const { POST } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.passwordTest; fixture.dispose(); });

function setup({ policy = false, concurrent = "", authorized = true } = {}) {
	sqlite?.close();
	const proxy = sqliteProxy({
		schema: `CREATE TABLE users (id TEXT, password_hash TEXT, security_version INTEGER, totp_enabled INTEGER, require_second_factor INTEGER, passkey_count INTEGER);
			INSERT INTO users VALUES ('user','!passkey-only',0,0,${policy ? 1 : 0},1)`,
	});
	sqlite = proxy.sqlite;
	globalThis.passwordTest = {
		db: proxy.db, sqlite,
		user: { id: "user", passwordHash: "!passkey-only", securityVersion: 0, totpEnabled: false, requireSecondFactor: policy },
		consume: () => { if (concurrent) sqlite.exec(concurrent); return authorized; },
	};
}

function enroll(requireSecondFactor) {
	return POST(new Request("https://mail.test/api/settings/password", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ newPassword: "new-password", stepUpToken: "valid-test-proof", ...(requireSecondFactor === undefined ? {} : { requireSecondFactor }) }),
	}));
}
const row = () => sqlite.prepare("SELECT * FROM users").get();

test("password and selected second-factor policy are saved together", async () => {
	for (const policy of [true, false]) {
		setup();
		assert.equal((await enroll(policy)).status, 200);
		assert.equal(row().password_hash, "hashed-new-password");
		assert.equal(row().require_second_factor, Number(policy));
		assert.equal(row().security_version, 1);
	}
});

test("legacy password enrollment preserves its current policy", async () => {
	setup({ policy: true });
	assert.equal((await enroll()).status, 200);
	assert.equal(row().require_second_factor, 1);
});

test("password enrollment rejects invalid authorization and malformed policy", async () => {
	setup({ authorized: false });
	assert.equal((await enroll(false)).status, 401);
	assert.equal(row().password_hash, "!passkey-only");
	setup();
	assert.equal((await enroll("false")).status, 400);
	assert.equal(row().password_hash, "!passkey-only");
});

test("concurrent MFA activation or security changes cannot be overwritten by password enrollment", async () => {
	for (const concurrent of [
		"UPDATE users SET totp_enabled=1, require_second_factor=1",
		"UPDATE users SET totp_enabled=1",
		"UPDATE users SET require_second_factor=1",
		"UPDATE users SET security_version=security_version+1",
		"UPDATE users SET passkey_count=0",
	]) {
		setup({ concurrent });
		assert.equal((await enroll(true)).status, 409, concurrent);
		assert.equal(row().password_hash, "!passkey-only");
	}
	setup({ concurrent: "UPDATE users SET totp_enabled=1, require_second_factor=1" });
	assert.equal((await enroll(false)).status, 409);
	assert.equal(row().require_second_factor, 1);
	assert.equal(row().password_hash, "!passkey-only");
});

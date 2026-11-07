import assert from "node:assert/strict";
import test, { after } from "node:test";
import { concurrentPasswordWrite, installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({
	name: "password-change-race",
	entryPoint: "src/app/api/settings/password/route.ts",
	mocks: {
		"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
		"@/db": "export function getDb(){return globalThis.passwordChangeRace.db}",
		"@/lib/cloudflare": "export function getEnv(){return {}}",
		"@/lib/auth/cookies": "export async function requireUser(){return globalThis.passwordChangeRace.user}",
		"@/lib/auth/session": "export function getSessionTokenFromRequestHeaders(){return 'session'} export async function deleteUserSessions(){globalThis.passwordChangeRace.sessions++}",
		"@/lib/auth/password": "export const PASSWORDLESS_PASSWORD_HASH='!passkey-only'; export function hasPasswordHash(value){return !!value && value!=='!passkey-only'} export function hashPassword(value){return 'hashed-'+value} export function verifyPassword(password){return password==='current-password'}",
		"@/lib/validators": "export const passwordSetSchema={safeParse:()=>({success:false})}; export const stepUpTokenSchema={safeParse:()=>({success:false})};",
		"@/lib/http/request": "export async function readJsonBody(){return null}",
		"@/lib/auth/webauthn/grants": "export async function consumeStepUpGrant(){return false} export async function bumpSecurityVersion(){globalThis.passwordChangeRace.sqlite.exec('UPDATE users SET security_version=security_version+1')}",
		"@/lib/auth/webauthn/credentials": "export async function countPasskeys(){return 1}",
		"@/lib/auth/activity": "export async function recordAuthActivity(){}",
		"./utils": "export async function parseChangePasswordRequest(){return {currentPassword:'current-password',newPassword:'new-password'}}",
	},
});
const { PATCH } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.passwordChangeRace; fixture.dispose(); });

function setup({ concurrent = "" } = {}) {
	sqlite?.close();
	sqlite = installSqlite("passwordChangeRace", {
		schema: `CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, security_version INTEGER NOT NULL DEFAULT 0, totp_enabled INTEGER NOT NULL DEFAULT 0, require_second_factor INTEGER NOT NULL DEFAULT 1);
			INSERT INTO users VALUES ('user','$2b$12$old',2,0,1);`,
		beforeQuery: concurrentPasswordWrite(concurrent),
		extra: {
			sessions: 0,
			user: { id: "user", passwordHash: "$2b$12$old", securityVersion: 2, totpEnabled: false, requireSecondFactor: true },
		},
	});
}

const change = () => PATCH(new Request("https://mail.test/api/settings/password", { method: "PATCH" }));
const row = () => sqlite.prepare("SELECT * FROM users").get();

test("changing a password writes it and revokes the other sessions", async () => {
	setup();
	const response = await change();
	assert.equal(response.status, 200);
	assert.equal(row().password_hash, "hashed-new-password");
	assert.equal(row().security_version, 3);
	assert.equal(globalThis.passwordChangeRace.sessions, 1);
});

test("a concurrent password removal cannot be overwritten by the change form", async () => {
	setup({ concurrent: "UPDATE users SET password_hash='!passkey-only' WHERE id='user'" });
	const response = await change();
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "action_conflict");
	assert.equal(row().password_hash, "!passkey-only");
	assert.equal(globalThis.passwordChangeRace.sessions, 0);
});

test("a concurrent security-version bump rejects the stale password snapshot", async () => {
	setup({ concurrent: "UPDATE users SET security_version=security_version+1 WHERE id='user'" });
	const response = await change();
	assert.equal(response.status, 409);
	assert.equal(row().password_hash, "$2b$12$old");
	assert.equal(globalThis.passwordChangeRace.sessions, 0);
});

test("concurrent TOTP and second-factor policy changes reject the stale snapshot", async () => {
	for (const concurrent of [
		"UPDATE users SET totp_enabled=1 WHERE id='user'",
		"UPDATE users SET require_second_factor=0 WHERE id='user'",
	]) {
		setup({ concurrent });
		const response = await change();
		assert.equal(response.status, 409, concurrent);
		assert.equal(row().password_hash, "$2b$12$old");
		assert.equal(globalThis.passwordChangeRace.sessions, 0);
	}
});

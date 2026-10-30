import assert from "node:assert/strict";
import test, { after } from "node:test";
import { concurrentPasswordWrite, installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({
	name: "password-reset-race",
	entryPoint: "src/lib/auth/password-reset.ts",
	mocks: {
		"@/db": "export function getDb(){return globalThis.resetRace.db}",
		"@/lib/ids": "export function newId(prefix){return prefix+'-id'}",
		"@/lib/auth/session": "export async function hashSessionToken(token){return 'hash-'+token} export async function deleteUserSessions(){globalThis.resetRace.sessions++}",
		"@/lib/auth/password": "export function hasPasswordHash(value){return !!value && value!=='!passkey-only'} export function hashPassword(value){return 'hashed-'+value}",
		"@/lib/branding/service": "export async function getBranding(){return {appName:'Test'}}",
		"@/lib/email/system-mail": "export async function sendSystemEmail(){return true}",
		"@/lib/mailboxes/audit": "export async function createAuditLog(){globalThis.resetRace.audits++}",
		"@/lib/auth/client-ip": "export function getClientIp(){return '127.0.0.1'}",
		"@/lib/auth/password-reset-utils": "export function buildPasswordResetEmail(){return {subject:'',text:'',html:''}}",
	},
});
const { completePasswordReset } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.resetRace; fixture.dispose(); });

function setup({ concurrent = "", used = false } = {}) {
	sqlite?.close();
	sqlite = installSqlite("resetRace", {
		schema: `CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, security_version INTEGER NOT NULL DEFAULT 0, totp_enabled INTEGER NOT NULL DEFAULT 0, require_second_factor INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE password_reset_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used_at INTEGER);
			INSERT INTO users VALUES ('user','$2b$12$old',3,0,1);
			INSERT INTO password_reset_tokens VALUES ('token','user','hash-token',${Math.floor(Date.now() / 1000) + 600},${used ? 1 : "NULL"});`,
		beforeQuery: concurrentPasswordWrite(concurrent),
		extra: { sessions: 0, audits: 0 },
	});
}

const reset = () => completePasswordReset({}, "token", "new-password", new Request("https://mail.test/reset-password"));

test("a reset writes the password, burns the token and signs the user out", async () => {
	setup();
	const result = await reset();
	assert.deepEqual(result, { ok: true });
	assert.equal(sqlite.prepare("SELECT password_hash FROM users").get().password_hash, "hashed-new-password");
	assert.ok(sqlite.prepare("SELECT used_at FROM password_reset_tokens").get().used_at);
	assert.equal(globalThis.resetRace.sessions, 1);
	assert.equal(globalThis.resetRace.audits, 1);
});

test("a concurrent move to passkey-only cannot be reverted by a reset", async () => {
	setup({ concurrent: "UPDATE users SET password_hash='!passkey-only', security_version=security_version+1" });
	const result = await reset();
	assert.equal(result.ok, false);
	assert.match(result.error, /invalid or has expired/);
	const user = sqlite.prepare("SELECT password_hash FROM users").get();
	assert.equal(user.password_hash, "!passkey-only");
	assert.ok(sqlite.prepare("SELECT used_at FROM password_reset_tokens").get().used_at);
	assert.equal(globalThis.resetRace.sessions, 0);
});

test("a concurrent security-version bump rejects the stale reset snapshot", async () => {
	setup({ concurrent: "UPDATE users SET security_version=security_version+1" });
	const result = await reset();
	assert.equal(result.ok, false);
	assert.equal(sqlite.prepare("SELECT password_hash FROM users").get().password_hash, "$2b$12$old");
	assert.equal(globalThis.resetRace.sessions, 0);
});

test("a concurrent TOTP change rejects the stale reset snapshot", async () => {
	setup({ concurrent: "UPDATE users SET totp_enabled=1" });
	const result = await reset();
	assert.equal(result.ok, false);
	assert.equal(sqlite.prepare("SELECT password_hash FROM users").get().password_hash, "$2b$12$old");
});

test("a concurrent password change is not overwritten by a reset", async () => {
	setup({ concurrent: "UPDATE users SET password_hash='$2b$12$other', security_version=security_version+1" });
	const result = await reset();
	assert.equal(result.ok, false);
	assert.equal(sqlite.prepare("SELECT password_hash FROM users").get().password_hash, "$2b$12$other");
});

test("a token that was already used is rejected before any write", async () => {
	setup({ used: true });
	const result = await reset();
	assert.equal(result.ok, false);
	assert.equal(sqlite.prepare("SELECT password_hash FROM users").get().password_hash, "$2b$12$old");
	assert.equal(globalThis.resetRace.sessions, 0);
});

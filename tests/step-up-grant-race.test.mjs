import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({
	name: "step-up-grant-race",
	entryPoint: "src/lib/auth/webauthn/grants.ts",
	mocks: {
		"@/db": "export function getDb(){return globalThis.grantRace.db}",
		"@/lib/ids": "let seq=0; export function newId(prefix){return prefix+'-'+(++seq)}",
		"@/lib/auth/session": "export async function hashSessionToken(token){return 'hash-'+token}",
	},
});
const { bumpSecurityVersion, consumeStepUpGrant, createStepUpGrant, peekStepUpGrant, StaleStepUpProofError } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.grantRace; fixture.dispose(); });

function setup() {
	sqlite?.close();
	let afterInsert = null;
	sqlite = installSqlite("grantRace", {
		schema: `CREATE TABLE users (id TEXT PRIMARY KEY, security_version INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE auth_step_ups (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL, target_user_id TEXT, security_version INTEGER NOT NULL DEFAULT 0, actor_security_version INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
			INSERT INTO users VALUES ('admin',0);
			INSERT INTO users VALUES ('target',0);`,
		afterQuery(sql) {
			if (afterInsert && /insert\s+into\s+"?auth_step_ups"?/i.test(sql)) {
				afterInsert();
				afterInsert = null;
			}
		},
		extra: { afterInsert: (hook) => { afterInsert = hook; } },
	});
}

const grantInput = (overrides = {}) => ({
	userId: "admin",
	sessionToken: "session",
	action: "admin.password_reset",
	targetUserId: "target",
	...overrides,
});
const adminGrant = (expectedActorSecurityVersion = 0) => createStepUpGrant({}, grantInput({ expectedActorSecurityVersion }));
const consume = (token) => consumeStepUpGrant({}, grantInput({ token }));
const peek = (token) => peekStepUpGrant({}, grantInput({ token }));
const grants = () => sqlite.prepare("SELECT * FROM auth_step_ups").all();

test("a step-up grant is single use", async () => {
	setup();
	const token = await adminGrant();
	assert.equal(await consume(token), true);
	assert.equal(await consume(token), false);
});

test("a targeted grant stops working when the actor's security state changes", async () => {
	setup();
	const token = await adminGrant();
	await bumpSecurityVersion(globalThis.grantRace.db, "admin");
	assert.equal(await consume(token), false);
	assert.equal(grants().length, 0);
});

test("a targeted grant stops working when the target's security state changes", async () => {
	setup();
	const token = await adminGrant();
	await bumpSecurityVersion(globalThis.grantRace.db, "target");
	assert.equal(await consume(token), false);
	assert.equal(grants().length, 0);
});

test("a failed grant cleanup cannot keep a grant after the actor's security changes", async () => {
	setup();
	const token = await adminGrant();
	sqlite.exec(`CREATE TRIGGER fail_step_up_delete BEFORE DELETE ON auth_step_ups
		BEGIN SELECT RAISE(ABORT, 'delete failed'); END;`);
	await assert.rejects(
		bumpSecurityVersion(globalThis.grantRace.db, "admin"),
		(error) => {
			for (let cause = error.cause; cause; cause = cause.cause) {
				if (String(cause.message ?? cause).includes("delete failed")) return true;
			}
			return false;
		},
	);
	// The version bump committed even though revoking the row failed.
	assert.equal(sqlite.prepare("SELECT security_version FROM users WHERE id='admin'").get().security_version, 1);
	assert.equal(grants().length, 1);
	assert.equal(await peek(token), false);
	assert.equal(await consume(token), false);
});

test("a stale proof snapshot cannot be exchanged for a grant after an actor security change", async () => {
	setup();
	await bumpSecurityVersion(globalThis.grantRace.db, "admin");
	await assert.rejects(adminGrant(0), (error) => error instanceof StaleStepUpProofError);
	assert.equal(grants().length, 0);
});

test("a security change between the insert and the post-insert check cannot leave a live grant", async () => {
	setup();
	globalThis.grantRace.afterInsert(() => {
		sqlite.exec("UPDATE users SET security_version=security_version+1 WHERE id='admin'");
	});
	await assert.rejects(adminGrant(), /security state changed/);
	assert.equal(grants().length, 0);
});

test("a target security change during grant creation is not returned as a usable token", async () => {
	setup();
	globalThis.grantRace.afterInsert(() => {
		sqlite.exec("UPDATE users SET security_version=security_version+1 WHERE id='target'");
	});
	await assert.rejects(adminGrant(), /security state changed/);
	assert.equal(grants().length, 0);
});

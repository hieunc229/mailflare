import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));

function database({ foreignKeys = false } = {}) {
	const db = new Database(":memory:");
	db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
	for (const migration of migrations) for (const statement of migration.statements) db.exec(statement);
	return db;
}

function addUser(db, { id, passwordHash, requireSecondFactor = 0, totpEnabled = 0 }) {
	db.prepare(
		`INSERT INTO users (
			id, email, password_hash, name, role, is_primary_admin, disabled, can_manage_mailboxes,
			can_manage_domains, can_manage_users, keyboard_shortcuts_enabled, spam_protection_enabled,
			show_full_recipient_addresses, remote_content_mode, require_second_factor, totp_enabled, created_at
		) VALUES (?, ?, ?, 'User', 'user', 0, 0, 0, 0, 0, 1, 1, 0, 'allow', ?, ?, 1)`,
	).run(id, `${id}@example.test`, passwordHash, requireSecondFactor, totpEnabled);
}

function addPasskey(db, { id, userId }) {
	db.prepare(
		`INSERT INTO passkey_credentials (
			id, user_id, credential_id, credential_hash, public_key, counter, device_type, backed_up, name, created_at
		) VALUES (?, ?, ?, ?, 'key', 0, 'singleDevice', 0, 'Test', 1)`,
	).run(id, userId, id, `hash-${id}`);
}

test("deleting credentials keeps passkey_count in step", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "$2b$12$hash" });
	addPasskey(db, { id: "p1", userId: "u1" });
	addPasskey(db, { id: "p2", userId: "u1" });
	assert.equal(db.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 2);
	db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run();
	assert.equal(db.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 1);
});

test("a passwordless account cannot lose its last passkey", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "!passkey-only" });
	addPasskey(db, { id: "p1", userId: "u1" });
	assert.throws(() => db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run(), /last-auth-method/);
	assert.equal(db.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 1);
});

test("removing the password is rejected when no passkey remains", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "$2b$12$hash" });
	addPasskey(db, { id: "p1", userId: "u1" });
	db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run();
	assert.throws(
		() => db.prepare("UPDATE users SET password_hash = '!passkey-only' WHERE id = 'u1'").run(),
		/last-auth-method/,
	);
});

test("a required second factor is cleared when the password remains and TOTP is off", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "$2b$12$hash", requireSecondFactor: 1 });
	addPasskey(db, { id: "p1", userId: "u1" });
	db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run();
	const user = db.prepare("SELECT passkey_count, require_second_factor FROM users WHERE id = 'u1'").get();
	assert.deepEqual(user, { passkey_count: 0, require_second_factor: 0 });
});

test("removing one of several passkeys keeps a required second factor", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "$2b$12$hash", requireSecondFactor: 1 });
	addPasskey(db, { id: "p1", userId: "u1" });
	addPasskey(db, { id: "p2", userId: "u1" });
	db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run();
	const user = db.prepare("SELECT passkey_count, require_second_factor FROM users WHERE id = 'u1'").get();
	assert.deepEqual(user, { passkey_count: 1, require_second_factor: 1 });
});

test("a required second factor stays when TOTP can still satisfy it", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "$2b$12$hash", requireSecondFactor: 1, totpEnabled: 1 });
	addPasskey(db, { id: "p1", userId: "u1" });
	db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run();
	const user = db.prepare("SELECT passkey_count, require_second_factor FROM users WHERE id = 'u1'").get();
	assert.deepEqual(user, { passkey_count: 0, require_second_factor: 1 });
});

test("a rejected last-passkey deletion rolls back the policy change", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "!passkey-only", requireSecondFactor: 1 });
	addPasskey(db, { id: "p1", userId: "u1" });
	assert.throws(() => db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run(), /last-auth-method/);
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM passkey_credentials WHERE id = 'p1'").get().count, 1);
	const user = db.prepare("SELECT passkey_count, require_second_factor FROM users WHERE id = 'u1'").get();
	assert.deepEqual(user, { passkey_count: 1, require_second_factor: 1 });
});

test("purging a deleted account can remove its last passkey", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "!passkey-only", requireSecondFactor: 1 });
	addPasskey(db, { id: "p1", userId: "u1" });
	db.prepare("UPDATE users SET deleted_at = 1 WHERE id = 'u1'").run();
	db.prepare("DELETE FROM users WHERE id = 'u1'").run();
	// Restore deletes users before the credential table; with foreign keys off
	// the credentials remain and must not trip the guard once their owner is gone.
	db.prepare("DELETE FROM passkey_credentials").run();
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get().count, 0);
});

test("purging a deleted account cascades through its last passkey", () => {
	const db = database({ foreignKeys: true });
	addUser(db, { id: "u1", passwordHash: "!passkey-only", requireSecondFactor: 1 });
	addPasskey(db, { id: "p1", userId: "u1" });
	db.prepare("UPDATE users SET deleted_at = 1 WHERE id = 'u1'").run();
	db.prepare("DELETE FROM users WHERE id = 'u1'").run();
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get().count, 0);
});

test("requiring a second step needs an enrolled factor", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "$2b$12$hash" });
	assert.throws(
		() => db.prepare("UPDATE users SET require_second_factor = 1 WHERE id = 'u1'").run(),
		/second-factor-unavailable/,
	);
	addPasskey(db, { id: "p1", userId: "u1" });
	db.prepare("UPDATE users SET require_second_factor = 1 WHERE id = 'u1'").run();
	assert.equal(db.prepare("SELECT require_second_factor FROM users WHERE id = 'u1'").get().require_second_factor, 1);
});

test("step-up grants carry the acting account's security version", () => {
	const db = database();
	const columns = db.prepare("PRAGMA table_info(auth_step_ups)").all();
	const column = columns.find((candidate) => candidate.name === "actor_security_version");
	assert.ok(column, "auth_step_ups lacks actor_security_version");
	assert.equal(column.notnull, 1);
	assert.equal(column.dflt_value, "0");
});

test("PostgreSQL and MySQL ship the consolidated passkey triggers and bound-grant columns", () => {
	for (const directory of ["drizzle/migrations-pg", "drizzle/migrations-mysql"]) {
		const sql = readFileSync(new URL(`../${directory}/0004_passkeys_and_step_up_grants.sql`, import.meta.url), "utf8");
		for (const needle of ["passkey_count", "last-auth-method", "second-factor-unavailable", "security_version", "actor_security_version", "target_user_id"]) {
			assert.ok(sql.includes(needle), `${directory} lacks ${needle}`);
		}
		assert.match(sql, /passkey_count[`"]? = [`"]?passkey_count[`"]? - 1/, `${directory} lacks the passkey count decrement`);
		assert.match(sql, /require_second_factor[`"]? = (?:false|0)/, `${directory} lacks the second-factor reset`);
		assert.ok(sql.includes("!passkey-only"), `${directory} lacks the passwordless guard`);
		assert.ok(!sql.includes("DROP TRIGGER"), `${directory} must not replace the trigger in a separate migration`);
		assert.equal(
			[...sql.matchAll(/CREATE TRIGGER [`"]?passkey_credentials_count_delete/gi)].length,
			1,
			`${directory} creates the last-passkey delete trigger once`,
		);
	}
});

test("a normal password-only fallback allows the last passkey to go", () => {
	const db = database();
	addUser(db, { id: "u1", passwordHash: "$2b$12$hash" });
	addPasskey(db, { id: "p1", userId: "u1" });
	db.prepare("DELETE FROM passkey_credentials WHERE id = 'p1'").run();
	assert.equal(db.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 0);
});

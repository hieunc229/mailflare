import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("recovery-codes-atomic", `
	export { issueRecoveryCodes, consumeRecoveryCode, countUnusedRecoveryCodes } from "./src/lib/auth/recovery-codes.ts";
`);

const seed = (t) => newDatabase(t, "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.com', 'x', 'U', 'user', 1);");

test("a failed re-issue keeps the user's existing codes", async (t) => {
	const { env, sqlite } = await seed(t);
	const [oldCode] = await app.issueRecoveryCodes(env, "u1");
	sqlite.exec("CREATE TRIGGER block_recovery_insert BEFORE INSERT ON mfa_recovery_codes BEGIN SELECT RAISE(ABORT, 'insert failed'); END;");
	await assert.rejects(app.issueRecoveryCodes(env, "u1"));
	assert.equal(await app.countUnusedRecoveryCodes(env, "u1"), 8);
	assert.equal(await app.consumeRecoveryCode(env, "u1", oldCode), true);
});

test("re-issuing replaces the whole set", async (t) => {
	const { env } = await seed(t);
	const [first] = await app.issueRecoveryCodes(env, "u1");
	const second = await app.issueRecoveryCodes(env, "u1");
	assert.equal(second.length, 8);
	assert.equal(await app.countUnusedRecoveryCodes(env, "u1"), 8);
	assert.equal(await app.consumeRecoveryCode(env, "u1", first), false);
});

test("on a driver whose batch is not atomic, a failed insert still leaves the old codes", async (t) => {
	const { env, sqlite } = await seed(t);
	const [oldCode] = await app.issueRecoveryCodes(env, "u1");
	// Neon HTTP runs batch statements one by one without a transaction.
	env.DB.batch = async (statements) => {
		const results = [];
		for (const statement of statements) results.push(await statement.all());
		return results;
	};
	sqlite.exec("CREATE TRIGGER block_recovery_insert BEFORE INSERT ON mfa_recovery_codes BEGIN SELECT RAISE(ABORT, 'insert failed'); END;");
	await assert.rejects(app.issueRecoveryCodes(env, "u1"));
	assert.equal(await app.countUnusedRecoveryCodes(env, "u1"), 8);
	assert.equal(await app.consumeRecoveryCode(env, "u1", oldCode), true);
});

test("the new codes are inserted before the old ones are deleted", async (t) => {
	const { env } = await seed(t);
	await app.issueRecoveryCodes(env, "u1");
	const batch = env.DB.batch.bind(env.DB);
	let order = [];
	env.DB.batch = async (statements) => {
		order = statements.map((statement) => statement.sql.trim().split(/\s+/)[0].toLowerCase());
		return batch(statements);
	};
	await app.issueRecoveryCodes(env, "u1");
	assert.deepEqual(order, ["insert", "delete"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("session-user-join", `
	export { createSession, getUserFromSession, hashSessionToken } from "./src/lib/auth/session.ts";
`);

const SEED = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('u1', 'u1@example.com', 'x', 'One', 'user', 1);
	INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES
		('u2', 'u2@example.com', 'x', 'Two', 'user', 1, 1);
`;

function countQueries(env) {
	const sql = [];
	const prepare = env.DB.prepare.bind(env.DB);
	env.DB.prepare = (text) => (sql.push(text), prepare(text));
	return sql;
}

async function insertSession(sqlite, id, userId, token, expiresAtMs) {
	const hash = await app.hashSessionToken(token);
	sqlite.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, 1)").run(id, userId, hash, Math.floor(expiresAtMs / 1000));
}

test("a valid session resolves its user in one query", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED);
	await insertSession(sqlite, "s1", "u1", "tok1", Date.now() + 60_000);
	const sql = countQueries(env);
	const user = await app.getUserFromSession(env, "tok1");
	assert.equal(user?.id, "u1");
	assert.equal(user?.email, "u1@example.com");
	assert.equal(sql.length, 1, sql.join("\n"));
});

test("an expired session returns null", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED);
	await insertSession(sqlite, "s1", "u1", "tok1", Date.now() - 1000);
	assert.equal(await app.getUserFromSession(env, "tok1"), null);
});

test("an unknown token and a missing token return null", async (t) => {
	const { env } = await newDatabase(t, SEED);
	assert.equal(await app.getUserFromSession(env, "nope"), null);
	assert.equal(await app.getUserFromSession(env, undefined), null);
});

test("a disabled user is still returned with disabled set, as before", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED);
	await insertSession(sqlite, "s2", "u2", "tok2", Date.now() + 60_000);
	const user = await app.getUserFromSession(env, "tok2");
	assert.equal(user?.id, "u2");
	assert.equal(user?.disabled, true);
});

test("the lookup reads the primary binding", async (t) => {
	const { env, sqlite } = await newDatabase(t, SEED);
	await insertSession(sqlite, "s1", "u1", "tok1", Date.now() + 60_000);
	const replica = { prepare() { throw new Error("replica read"); } };
	const user = await app.getUserFromSession({ DB: replica, DB_PRIMARY: env.DB }, "tok1");
	assert.equal(user?.id, "u1");
});

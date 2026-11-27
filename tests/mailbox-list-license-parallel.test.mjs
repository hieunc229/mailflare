import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("mailbox-license-parallel", `
	export { listAccessibleMailboxes } from "./src/lib/mailboxes/access.ts";
`);

// Delays each statement by a tick and records how many are in flight at once.
function trackConcurrency(env) {
	const stats = { inFlight: 0, maxInFlight: 0, sql: [] };
	const wrap = (statement) => {
		const run = (method) => async (...args) => {
			stats.inFlight += 1;
			stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
			await new Promise((done) => setTimeout(done, 5));
			stats.inFlight -= 1;
			return statement[method](...args);
		};
		return {
			bind: (...values) => wrap(statement.bind(...values)),
			first: run("first"), run: run("run"), all: run("all"), raw: run("raw"),
		};
	};
	const prepare = env.DB.prepare.bind(env.DB);
	env.DB.prepare = (text) => (stats.sql.push(text), wrap(prepare(text)));
	return stats;
}

const delegate = { id: "delegate", email: "delegate@example.com", role: "user" };

test("team plan: owned and shared mailboxes are listed", async (t) => {
	const { db } = await newDatabase(t, sharedMailboxSeed("full_access"));
	const rows = await app.listAccessibleMailboxes(db, delegate);
	assert.deepEqual(rows.map((row) => [row.id, row.permission]), [["mb-delegate", "full_access"], ["mb-team", "full_access"]]);
});

test("non-team plan: only owned mailboxes are listed", async (t) => {
	const { db, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access"));
	sqlite.exec("UPDATE license_settings SET plan = 'free'");
	const rows = await app.listAccessibleMailboxes(db, delegate);
	assert.deepEqual(rows.map((row) => row.id), ["mb-delegate"]);
});

test("a failing license read falls back to owned mailboxes only", async (t) => {
	const { db, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access"));
	sqlite.exec("DROP TABLE license_settings");
	const rows = await app.listAccessibleMailboxes(db, delegate);
	assert.deepEqual(rows.map((row) => row.id), ["mb-delegate"]);
});

test("the license read runs alongside the owned-mailboxes query", async (t) => {
	const { env, db } = await newDatabase(t, sharedMailboxSeed("full_access"));
	const stats = trackConcurrency(env);
	await app.listAccessibleMailboxes(db, delegate);
	assert.equal(stats.sql.length, 3, stats.sql.join("\n"));
	assert.equal(stats.maxInFlight, 2);
});

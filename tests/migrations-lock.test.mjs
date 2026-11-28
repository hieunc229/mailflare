import assert from "node:assert/strict";
import test from "node:test";
import { fakeDatabase, fakeServer, loadMigrationService } from "./helpers/migration-fake.mjs";

const migrations = [{ name: "0001_a.sql", statements: ["CREATE TABLE a (id int)", "CREATE INDEX a_id ON a (id)"] }];
const { applyPendingMigrations } = await loadMigrationService("migrations-lock", { mysql: { migrations }, postgres: { migrations } });
const count = (db, sql) => db.state.executed.filter((entry) => entry === sql).length;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

for (const dialect of ["mysql", "postgres"]) {
	test(`${dialect}: the second runner waits for the lock, then finds the work done`, async () => {
		const server = fakeServer();
		let open;
		const gate = new Promise((resolve) => (open = resolve));
		const first = fakeDatabase(dialect, { server, name: "first", fail: (sql) => (sql === "CREATE TABLE a (id int)" ? gate : undefined) });
		const second = fakeDatabase(dialect, { server, name: "second" });
		const running = applyPendingMigrations(first);
		await tick();
		const waiting = applyPendingMigrations(second);
		await tick();
		assert.deepEqual(second.state.executed, [], "the second runner has not run anything while the first holds the lock");
		open();
		const [one, two] = await Promise.all([running, waiting]);
		assert.deepEqual(one.applied, ["0001_a.sql"]);
		assert.deepEqual(two.applied, []);
		assert.equal(count(first, "CREATE TABLE a (id int)") + count(second, "CREATE TABLE a (id int)"), 1);
		assert.deepEqual(server.lockLog, ["acquire first", "release first", "acquire second", "release second"]);
	});

	test(`${dialect}: the lock is released when a migration fails`, async () => {
		const server = fakeServer();
		const broken = fakeDatabase(dialect, { server, name: "broken", fail: () => { throw new Error("lost connection"); } });
		await assert.rejects(applyPendingMigrations(broken), /^Error: Migration 0001_a\.sql failed/);
		assert.equal(server.lockHeld, false);
		const result = await applyPendingMigrations(fakeDatabase(dialect, { server, name: "next" }));
		assert.deepEqual(result.applied, ["0001_a.sql"]);
	});
}

// Decided by driver kind: only a pooled connection (node-postgres, postgres.js, mysql2) can hold a lock. Every executor has a
// `transaction` method (lazyExecutor always defines one), so the method's presence says nothing.
for (const [dialect, driver] of [["postgres", "neon"], ["postgres", "pglite"], ["mysql", "planetscale"]]) {
	test(`${driver}: no lock is taken`, async () => {
		const server = fakeServer();
		const db = fakeDatabase(dialect, { server, driver });
		await applyPendingMigrations(db);
		assert.deepEqual(db.state.connectionQueries, []);
		assert.deepEqual(server.lockLog, []);
	});
}

test("postgres.js takes the lock like node-postgres", async () => {
	const db = fakeDatabase("postgres", { driver: "postgres-js" });
	await applyPendingMigrations(db);
	assert.ok(db.state.connectionQueries.some((sql) => /pg_advisory_xact_lock/.test(sql)));
});

test("postgres: a transaction-scoped lock, taken without a snapshot, with a deadline", async () => {
	const server = fakeServer();
	const db = fakeDatabase("postgres", { server });
	await applyPendingMigrations(db);
	const [first, second, idle, third] = db.state.connectionQueries;
	assert.equal(first, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
	assert.match(second, /^SET LOCAL lock_timeout = '600s'$/);
	assert.equal(idle, "SET LOCAL idle_in_transaction_session_timeout = 0", "a long migration must not be cut off while the lock transaction idles");
	assert.match(third, /^SELECT pg_advisory_xact_lock\(/);
	assert.equal(db.state.connectionQueries.length, 4, "there is no unlock to fail: COMMIT frees the lock");
	assert.equal(server.lockHeld, false);
});

test("postgres: waiting past the deadline gives a clear error", async () => {
	const db = fakeDatabase("postgres", { lockTimeout: true });
	await assert.rejects(applyPendingMigrations(db), /^Error: Timed out waiting for another instance to finish migrating\.$/);
});

for (const lockResult of [0, null]) {
	test(`mysql: GET_LOCK returning ${lockResult} fails clearly and runs nothing`, async () => {
		const db = fakeDatabase("mysql", { lockResult });
		await assert.rejects(applyPendingMigrations(db), /^Error: Timed out waiting for another instance to finish migrating\.$/);
		assert.deepEqual(db.state.executed, []);
	});
}

test("mysql: a connection that could not release the lock is discarded, not returned to the pool", async () => {
	const server = fakeServer();
	const db = fakeDatabase("mysql", { server, failRelease: true });
	const result = await applyPendingMigrations(db);
	assert.deepEqual(result.applied, ["0001_a.sql"]);
	assert.equal(db.state.discarded, true);
	const ok = fakeDatabase("mysql", { server: fakeServer() });
	await applyPendingMigrations(ok);
	assert.equal(ok.state.discarded, false);
});

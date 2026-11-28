import assert from "node:assert/strict";
import test from "node:test";
import { fakeDatabase, loadMigrationService } from "./helpers/migration-fake.mjs";

const mysql = {
	migrations: [
		{ name: "0001_a.sql", statements: ["CREATE TABLE a (id int)", "ALTER TABLE a ADD x int", "CREATE INDEX a_x ON a (x)", "INSERT IGNORE INTO a (id) VALUES (1)"] },
		{ name: "0002_b.sql", statements: ["CREATE TABLE b (id int)"] },
	],
};
const { applyPendingMigrations, getMigrationStatus } = await loadMigrationService("migrations-mysql-resume", { mysql });
const count = (db, sql) => db.state.executed.filter((entry) => entry === sql).length;

test("a failed statement resumes without re-running finished ones", async () => {
	let failed = false;
	const db = fakeDatabase("mysql", {
		fail(sql) {
			if (sql === "CREATE INDEX a_x ON a (x)" && !failed) {
				failed = true;
				throw new Error("lost connection");
			}
		},
	});
	await assert.rejects(applyPendingMigrations(db), /^Error: Migration 0001_a\.sql failed/);
	const status = await getMigrationStatus(db);
	assert.deepEqual(status.unknown, []);
	assert.equal(status.ready, false);
	const result = await applyPendingMigrations(db);
	assert.deepEqual(result.applied, ["0001_a.sql", "0002_b.sql"]);
	assert.equal(count(db, "CREATE TABLE a (id int)"), 1);
	assert.equal(count(db, "ALTER TABLE a ADD x int"), 1);
});

test("an already-exists error on the statement a failed run stopped at counts as done", async () => {
	let attempts = 0;
	const db = fakeDatabase("mysql", {
		fail(sql) {
			if (sql !== "ALTER TABLE a ADD x int") return;
			// The first run lost its connection while the server finished the statement.
			if (++attempts === 1) throw new Error("lost connection");
			throw Object.assign(new Error("Duplicate column name 'x'"), { errno: 1060 });
		},
	});
	await assert.rejects(applyPendingMigrations(db), /failed: lost connection/);
	const result = await applyPendingMigrations(db);
	assert.deepEqual(result.applied, ["0001_a.sql", "0002_b.sql"]);
	assert.equal(count(db, "ALTER TABLE a ADD x int"), 0);
	assert.equal(count(db, "CREATE INDEX a_x ON a (x)"), 1);
	assert.equal(count(db, "INSERT IGNORE INTO a (id) VALUES (1)"), 1);
});

test("a replica that lost the race succeeds", async () => {
	const db = fakeDatabase("mysql", {
		afterRun(sql, ledger) {
			if (sql.startsWith("INSERT IGNORE INTO a")) ledger.add("0001_a.sql");
		},
	});
	const result = await applyPendingMigrations(db);
	assert.equal(result.ready, true);
});

test("no progress rows remain after success", async () => {
	const db = fakeDatabase("mysql");
	await applyPendingMigrations(db);
	assert.deepEqual([...db.state.ledger].sort(), ["0001_a.sql", "0002_b.sql"]);
});

test("progress goes to its own table, never the migration ledger an older release reads", async () => {
	const db = fakeDatabase("mysql", {
		fail(sql) {
			if (sql === "CREATE INDEX a_x ON a (x)") throw new Error("lost connection");
		},
	});
	await assert.rejects(applyPendingMigrations(db), /^Error: Migration 0001_a\.sql failed/);
	assert.deepEqual([...db.state.ledger], []);
	assert.deepEqual([...db.state.steps].map((mark) => mark.replace(/:.*/, "")), ["0001_a.sql#start", "0001_a.sql#0", "0001_a.sql#1"]);
});

test("the progress table is gone once every migration is applied", async () => {
	const db = fakeDatabase("mysql");
	await applyPendingMigrations(db);
	assert.equal(db.state.server.created.has("mailflare_migration_steps"), false);
});

test("the progress table is dropped on a boot with nothing pending", async () => {
	const db = fakeDatabase("mysql");
	await applyPendingMigrations(db);
	// A leftover from a crash, or from a run that a rollback to an older release interrupted.
	db.state.server.created.add("mailflare_migration_steps");
	db.state.steps.add("0001_a.sql#0:00000000");
	const result = await applyPendingMigrations(db);
	assert.deepEqual(result.applied, []);
	assert.equal(db.state.server.created.has("mailflare_migration_steps"), false);
});

test("a progress mark covers the statement text, so a hotfixed statement runs again", async () => {
	let failed = false;
	const db = fakeDatabase("mysql", {
		fail(sql) {
			if (sql === "CREATE INDEX a_x ON a (x)" && !failed) {
				failed = true;
				throw new Error("lost connection");
			}
		},
	});
	await assert.rejects(applyPendingMigrations(db), /failed/);
	assert.deepEqual([...db.state.steps].map((mark) => mark.replace(/:.*/, "")), ["0001_a.sql#start", "0001_a.sql#0", "0001_a.sql#1"]);
	assert.match([...db.state.steps][1], /^0001_a\.sql#0:[0-9a-f]{8}$/);
	// The same names and indexes, one edited statement: the stale mark of statement 2 must not skip it.
	const hotfixed = { migrations: [{ name: "0001_a.sql", statements: ["CREATE TABLE a (id int)", "ALTER TABLE a ADD y int", "CREATE INDEX a_x ON a (x)", "INSERT IGNORE INTO a (id) VALUES (1)"] }] };
	const { applyPendingMigrations: apply } = await loadMigrationService("migrations-mysql-hotfix", { mysql: hotfixed });
	await apply(db);
	assert.equal(count(db, "ALTER TABLE a ADD y int"), 1);
	assert.equal(count(db, "CREATE TABLE a (id int)"), 1);
});

test("already-exists is tolerated only for the first unrecorded statement of a resumed migration", async () => {
	const exists = () => Object.assign(new Error("Duplicate column name 'x'"), { errno: 1060 });
	// A fresh migration: a duplicate is a real error.
	const fresh = fakeDatabase("mysql", { fail: (sql) => { if (sql === "CREATE TABLE a (id int)") throw exists(); } });
	await assert.rejects(applyPendingMigrations(fresh), /^Error: Migration 0001_a\.sql failed/);
	// A resumed one: the statement after the last mark may have run unrecorded; the ones after it may not.
	let crashed = false;
	const db = fakeDatabase("mysql", {
		failInsert(mark) {
			if (!mark.startsWith("0001_a.sql#1:") || crashed) return false;
			crashed = true;
			return true;
		},
		fail(sql) {
			if (crashed && sql === "CREATE INDEX a_x ON a (x)") throw exists();
			if (crashed && sql === "ALTER TABLE a ADD x int") throw exists();
		},
	});
	await assert.rejects(applyPendingMigrations(db), /failed/);
	await assert.rejects(applyPendingMigrations(db), /^Error: Migration 0001_a\.sql failed: Duplicate column name/);
	assert.equal(count(db, "INSERT IGNORE INTO a (id) VALUES (1)"), 0);
	assert.equal(db.state.steps.size, 3, "the statement after the tolerated one failed and was not recorded");
});

test("a crash after the first statement ran, before anything was recorded, resumes", async () => {
	const exists = () => Object.assign(new Error("Table 'a' already exists"), { errno: 1050 });
	let ran = false;
	let crashed = false;
	const db = fakeDatabase("mysql", {
		failInsert(name) {
			if (!name.startsWith("0001_a.sql#0:") || crashed) return false;
			crashed = true;
			return true;
		},
		fail(sql) {
			if (sql === "CREATE TABLE a (id int)") {
				if (ran) throw exists();
				ran = true;
			}
		},
	});
	await assert.rejects(applyPendingMigrations(db), /failed/);
	const result = await applyPendingMigrations(db);
	assert.deepEqual(result.applied, ["0001_a.sql", "0002_b.sql"]);
});

test("a first run still treats already-exists on the first statement as an error", async () => {
	const db = fakeDatabase("mysql", { fail(sql) { if (sql === "CREATE TABLE a (id int)") throw Object.assign(new Error("Table 'a' already exists"), { errno: 1050 }); } });
	await assert.rejects(applyPendingMigrations(db), /failed: Table 'a' already exists/);
});

for (const [label, message] of [["PlanetScale's DROP text", "Can't DROP 'a_x'; check that column/key exists (errno 1091)"], ["only an errno in the text", "target: vitess-shard: rpc error (errno 1061)"]]) {
	test(`a resumed statement whose error carries no errno field still counts as done: ${label}`, async () => {
		let attempts = 0;
		const db = fakeDatabase("mysql", {
			fail(sql) {
				if (sql !== "ALTER TABLE a ADD x int") return;
				if (++attempts === 1) throw new Error("lost connection");
				throw new Error(message);
			},
		});
		await assert.rejects(applyPendingMigrations(db), /failed: lost connection/);
		const result = await applyPendingMigrations(db);
		assert.deepEqual(result.applied, ["0001_a.sql", "0002_b.sql"]);
	});
}

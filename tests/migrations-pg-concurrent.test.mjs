import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeDatabase, loadMigrationService } from "./helpers/migration-fake.mjs";

const postgres = {
	migrations: [
		{ name: "0001_plain.sql", statements: ["CREATE TABLE a (id int)"] },
		{
			name: "0002_concurrent.sql",
			statements: ["ALTER TABLE a ADD COLUMN IF NOT EXISTS x int", "CREATE INDEX CONCURRENTLY IF NOT EXISTS a_x ON a (x)", "DROP INDEX CONCURRENTLY IF EXISTS a_old"],
		},
	],
};
const { applyPendingMigrations } = await loadMigrationService("migrations-pg-concurrent", { postgres });

test("a plain migration still uses one batch", async () => {
	const db = fakeDatabase("postgres");
	await applyPendingMigrations(db);
	const batch = db.state.batchCalls.find((sqls) => sqls.includes("CREATE TABLE a (id int)"));
	assert.ok(batch);
	assert.match(batch[0], /^INSERT INTO mailflare_migrations/);
});

test("a CONCURRENTLY migration never uses a batch", async () => {
	const db = fakeDatabase("postgres");
	await applyPendingMigrations(db);
	assert.equal(db.state.batchCalls.some((sqls) => sqls.some((sql) => sql.includes("a_x"))), false);
	assert.deepEqual(db.state.executed.slice(1), postgres.migrations[1].statements);
});

test("a CONCURRENTLY migration runs again from its first statement after a failure", async () => {
	let failed = false;
	const db = fakeDatabase("postgres", {
		fail(sql) {
			if (sql.startsWith("CREATE INDEX CONCURRENTLY") && !failed) {
				failed = true;
				throw new Error("canceling statement due to statement timeout");
			}
		},
	});
	await assert.rejects(applyPendingMigrations(db), /^Error: Migration 0002_concurrent\.sql failed/);
	assert.deepEqual([...db.state.steps], [], "no progress is recorded for PostgreSQL");
	await applyPendingMigrations(db);
	assert.equal(db.state.executed.filter((sql) => sql === "ALTER TABLE a ADD COLUMN IF NOT EXISTS x int").length, 2);
	assert.deepEqual([...db.state.ledger].sort(), ["0001_plain.sql", "0002_concurrent.sql"]);
	assert.equal(db.state.server.created.has("mailflare_migration_steps"), false);
});

test("the word CONCURRENTLY inside a function body or comment does not leave the transaction", async () => {
	const mention = {
		migrations: [{
			name: "0001_mention.sql",
			statements: [
				"CREATE FUNCTION f() RETURNS void AS $$ BEGIN -- never CREATE INDEX CONCURRENTLY here\nPERFORM 1; END $$ LANGUAGE plpgsql",
				"COMMENT ON FUNCTION f() IS 'DROP INDEX CONCURRENTLY IF EXISTS x'",
			],
		}],
	};
	const { applyPendingMigrations: apply } = await loadMigrationService("migrations-pg-mention", { postgres: mention });
	const db = fakeDatabase("postgres");
	await apply(db);
	assert.equal(db.state.batchCalls.length, 1);
});

test("an index left half-built by an interrupted run is dropped before it is built again", async () => {
	const rebuild = {
		migrations: [{
			name: "0001_index.sql",
			statements: ["DROP INDEX CONCURRENTLY IF EXISTS a_x", "CREATE INDEX CONCURRENTLY IF NOT EXISTS a_x ON a (x)"],
		}],
	};
	const { applyPendingMigrations: apply } = await loadMigrationService("migrations-pg-rebuild", { postgres: rebuild });
	let failed = false;
	const db = fakeDatabase("postgres", {
		fail(sql) {
			if (sql.startsWith("CREATE INDEX") && !failed) {
				failed = true;
				throw new Error("canceling statement due to statement timeout");
			}
		},
	});
	await assert.rejects(apply(db), /failed/);
	await apply(db);
	assert.deepEqual(db.state.executed.map((sql) => sql.split(" ")[0]), ["DROP", "DROP", "CREATE"]);
});

test("every statement of a bundled CONCURRENTLY migration can run twice", () => {
	const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle-postgres.json", import.meta.url), "utf8"));
	for (const migration of migrations.filter((candidate) => candidate.statements.some((statement) => /CONCURRENTLY/.test(statement)))) {
		for (const statement of migration.statements) {
			assert.match(statement, /\bIF (NOT )?EXISTS\b/i, `${migration.name}: ${statement.slice(0, 60)}`);
		}
	}
});

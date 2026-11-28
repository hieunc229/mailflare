import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import { fakeDatabase, loadMigrationService } from "./helpers/migration-fake.mjs";

const read = (file) => JSON.parse(readFileSync(new URL(`../src/lib/migrations/${file}`, import.meta.url), "utf8")).migrations;
const sqlite = read("bundle.json");
const postgres = read("bundle-postgres.json");
const mysql = read("bundle-mysql.json");
const statementsOf = (migrations) => migrations.flatMap((migration) => migration.statements.map((statement) => statement.trim()));
const schemaSource = readFileSync(new URL("../src/db/schema/index.ts", import.meta.url), "utf8");

/** Replays CREATE INDEX / DROP INDEX statements in order and returns the indexes still defined. */
function liveIndexes(migrations) {
	const live = new Set();
	for (const statement of statementsOf(migrations)) {
		const created = /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?[`"]?(\w+)/i.exec(statement);
		if (created) live.add(created[1]);
		const dropped = /^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?[`"]?(\w+)/i.exec(statement);
		if (dropped) live.delete(dropped[1]);
	}
	return live;
}

const REDUNDANT = [
	"mailbox_access_mailbox_idx", "contacts_user_idx", "folders_mailbox_idx", "spam_token_stats_mailbox_idx",
	"spam_reputation_mailbox_idx", "calendar_event_overrides_event_idx", "calendar_occurrence_responses_event_idx",
	"booking_events_user_idx", "auto_reply_deliveries_sent_idx", "webhook_deliveries_status_idx", "routing_rules_priority_idx",
	"audit_logs_target_user_idx",
];

test("dropped indexes are gone and the audit composite exists in every dialect bundle", () => {
	for (const [name, migrations] of Object.entries({ sqlite, postgres, mysql })) {
		const live = liveIndexes(migrations);
		for (const index of REDUNDANT) assert.equal(live.has(index), false, `${name} still has ${index}`);
		assert.equal(live.has("audit_logs_target_action_created_idx"), true, `${name} lacks the audit composite`);
	}
	const mysqlLive = liveIndexes(mysql);
	assert.equal(mysqlLive.has("messages_thread_key_idx"), false);
	assert.equal(mysqlLive.has("messages_mailbox_thread_key_idx"), false);
	assert.equal(liveIndexes(postgres).has("messages_thread_key_idx"), true);
	for (const index of REDUNDANT) assert.equal(schemaSource.includes(`"${index}"`), false, `schema still declares ${index}`);
});

test("the old audit index is dropped only after its replacement exists, in every dialect", () => {
	for (const [name, migrations] of Object.entries({ sqlite, postgres, mysql })) {
		const statements = statementsOf(migrations);
		const built = statements.findIndex((statement) => /^CREATE INDEX (CONCURRENTLY )?(IF NOT EXISTS )?[`"]audit_logs_target_action_created_idx/.test(statement));
		const dropped = statements.findIndex((statement) => /^DROP INDEX (CONCURRENTLY )?(IF EXISTS )?[`"]audit_logs_target_user_idx/.test(statement));
		assert.ok(built >= 0 && dropped > built, `${name}: replacement at ${built}, old index dropped at ${dropped}`);
	}
});

test("second-factor lookups use the audit composite", () => {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = OFF");
	for (const statement of statementsOf(sqlite)) db.exec(statement);
	const plan = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM audit_logs WHERE target_user_id = 'u' AND action = 'a' AND created_at > 1").all();
	assert.match(plan.map((row) => row.detail).join(" | "), /audit_logs_target_action_created_idx/);
});

test("MySQL indexes a prefix of the longtext action column instead of rewriting the audit table", () => {
	const statements = statementsOf(mysql);
	assert.equal(statements.some((statement) => /MODIFY `action`/.test(statement)), false);
	assert.ok(statements.some((statement) => statement.startsWith("CREATE INDEX `audit_logs_target_action_created_idx` ON `audit_logs` (`target_user_id`,`action`(64),`created_at`)")));
});

test("PostgreSQL builds the audit index concurrently, replacing a half-built one, in a migration of its own", () => {
	const owner = postgres.find((migration) => migration.statements.some((statement) => statement.includes("CREATE INDEX") && statement.includes("audit_logs_target_action_created_idx")));
	assert.deepEqual(owner.statements.map((statement) => statement.replace(/\s+/g, " ").replace(/ USING btree.*/, "")), [
		'DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_target_action_created_idx";',
		'CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_target_action_created_idx" ON "audit_logs"',
		'DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_target_user_idx";',
	]);
	assert.ok(postgres.filter((migration) => migration.statements.some((statement) => /CONCURRENTLY/.test(statement))).every((migration) => migration === owner));
});

test("PG and MySQL migrations set the remote content default to ask; MySQL promotion counters are bigint", () => {
	const pg = statementsOf(postgres).join("\n");
	const my = statementsOf(mysql).join("\n");
	assert.match(pg, /ALTER TABLE "users" ALTER COLUMN "remote_content_mode" SET DEFAULT 'ask'/);
	assert.match(my, /ALTER TABLE `users` ALTER COLUMN `remote_content_mode` SET DEFAULT 'ask'/);
	for (const column of ["backfill_scanned", "backfill_stalls", "backfill_day", "backfill_day_rows"]) {
		assert.match(my, new RegExp(`MODIFY \`${column}\` bigint NOT NULL DEFAULT 0`));
	}
	assert.equal(statementsOf(mysql).filter((statement) => /^ALTER TABLE `mailbox_promotion_settings` MODIFY `backfill_/.test(statement)).length, 1, "one table rewrite, not four");
	assert.match(schemaSource, /"remote_content_mode"[^\n]*\.default\("ask"\)/);
});

test("an update of a JMAP-invisible column logs no change; a visible one does", () => {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = OFF");
	for (const statement of statementsOf(sqlite)) db.exec(statement);
	db.exec("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('m1', 'u', 'mb1', 'inbound', 'a@x.test', 'b@x.test', 's', 'received', 1)");
	const changes = () => db.prepare("SELECT object_type, change FROM jmap_changes ORDER BY rowid").all().map((row) => `${row.object_type}:${row.change}`);
	const after = (sql) => {
		db.exec("DELETE FROM jmap_changes");
		db.exec(sql);
		return changes();
	};
	assert.deepEqual(after("UPDATE messages SET raw_r2_key = 'x' WHERE id = 'm1'"), []);
	assert.deepEqual(after("UPDATE messages SET spam_score = 5 WHERE id = 'm1'"), []);
	assert.deepEqual(after("UPDATE messages SET read = 1 WHERE id = 'm1'"), ["email:updated"]);
	const revision = () => db.prepare("SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = 'mb1'").pluck().get();
	const before = revision();
	db.exec("UPDATE messages SET raw_r2_key = 'y', spam_score = 7 WHERE id = 'm1'");
	assert.equal(revision(), before, "a hidden-column update leaves the mailbox revision alone");
	db.exec("UPDATE messages SET starred = 1 WHERE id = 'm1'");
	assert.equal(revision(), before + 1);
	assert.deepEqual(after("UPDATE messages SET mailbox_id = 'mb2' WHERE id = 'm1'").sort(), ["email:created", "email:destroyed"]);
});

test("PG and MySQL scope the email update trigger to the JMAP-visible columns", () => {
	const pg = statementsOf(postgres).join("\n");
	assert.match(pg, /CREATE TRIGGER messages_jmap_changed AFTER INSERT OR UPDATE OF [^;]*\bsubject\b[^;]* OR DELETE ON messages/);
	assert.doesNotMatch(pg.slice(pg.lastIndexOf("CREATE TRIGGER messages_jmap_changed")), /UPDATE OF [^;]*raw_r2_key/);
	const statements = statementsOf(mysql);
	const created = statements.findIndex((statement) => /^CREATE TRIGGER messages_jmap_au_v2 /.test(statement));
	assert.ok(created >= 0);
	const trigger = statements[created];
	assert.ok(statements.indexOf("DROP TRIGGER IF EXISTS messages_jmap_au;") > created, "the old trigger goes only after the new one exists");
	assert.match(trigger, /<=> NEW\.subject/);
	assert.doesNotMatch(trigger, /raw_r2_key/);
});

// MySQL cannot roll back DDL, so a run that stops after any statement is resumed by running that statement again.
const lows = mysql.find((migration) => migration.name === "0027_schema_lows.sql");
const { applyPendingMigrations } = await loadMigrationService("schema-lows-resume", { mysql: { migrations: [lows] } });

function mysqlSchema() {
	const indexes = new Set(lows.statements.map((statement) => /^DROP INDEX `(\w+)`/.exec(statement)?.[1]).filter(Boolean));
	const triggers = new Set(["messages_jmap_au"]); // the 0001 trigger an install starts with
	const error = (errno, message) => Object.assign(new Error(message), { errno });
	const apply = (sql) => {
		let found;
		if ((found = /^DROP INDEX `(\w+)`/.exec(sql))) {
			if (!indexes.delete(found[1])) throw error(1091, `Can't DROP '${found[1]}'; check that column/key exists`);
		} else if ((found = /^CREATE INDEX `(\w+)`/.exec(sql))) {
			if (indexes.has(found[1])) throw error(1061, `Duplicate key name '${found[1]}'`);
			indexes.add(found[1]);
		} else if ((found = /^DROP TRIGGER (IF EXISTS )?(\w+)/.exec(sql))) {
			if (!triggers.delete(found[2]) && !found[1]) throw error(1360, `Trigger does not exist`);
		} else if ((found = /^CREATE TRIGGER (\w+)/.exec(sql))) {
			if (triggers.has(found[1])) throw error(1359, "Trigger already exists");
			triggers.add(found[1]);
		}
	};
	return { indexes, triggers, apply };
}

test("MySQL 0027 resumes after a failure at CREATE TRIGGER", async () => {
	const schema = mysqlSchema();
	let failed = false;
	const db = fakeDatabase("mysql", {
		fail(sql) {
			if (sql.startsWith("CREATE TRIGGER") && !failed) {
				failed = true;
				throw new Error("lost connection");
			}
			schema.apply(sql);
		},
	});
	await assert.rejects(applyPendingMigrations(db), /^Error: Migration 0027_schema_lows\.sql failed: lost connection/);
	assert.deepEqual([...schema.triggers], ["messages_jmap_au"], "updates stay logged while the migration is stopped");
	await applyPendingMigrations(db);
	assert.deepEqual([...schema.triggers], ["messages_jmap_au_v2"]);
	assert.equal(db.state.executed.filter((sql) => sql.startsWith("DROP TRIGGER")).length, 1);
});

test("MySQL 0027 completes when the run stopped after any one statement, before it was recorded", async () => {
	for (const [index, statement] of lows.statements.entries()) {
		const schema = mysqlSchema();
		let crashed = false;
		const db = fakeDatabase("mysql", {
			fail: (sql) => schema.apply(sql),
			failInsert(name) {
				if (!name.startsWith(`0027_schema_lows.sql#${index}:`) || crashed) return false;
				crashed = true;
				return true;
			},
		});
		await assert.rejects(applyPendingMigrations(db), /failed/, `statement ${index + 1}: ${statement.slice(0, 40)}`);
		const result = await applyPendingMigrations(db);
		assert.deepEqual(result.applied, ["0027_schema_lows.sql"], `statement ${index + 1}: ${statement.slice(0, 40)}`);
		assert.deepEqual([...schema.triggers], ["messages_jmap_au_v2"]);
		assert.equal(schema.indexes.has("audit_logs_target_action_created_idx"), true);
	}
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";

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

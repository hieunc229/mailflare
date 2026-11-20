import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));

function database() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) db.exec(statement);
	return db;
}

const names = (db, sql) => db.prepare(sql).all().map((row) => row.name);

test("the promotions migration adds message columns, indexes and both tables", () => {
	const db = database();
	const columns = names(db, "select name from pragma_table_info('messages')");
	assert.ok(columns.includes("category") && columns.includes("sender_address"));
	const indexes = names(db, "select name from pragma_index_list('messages')");
	assert.ok(indexes.includes("messages_category_page_idx") && indexes.includes("messages_category_count_idx") && indexes.includes("messages_sender_idx"));
	assert.deepEqual(names(db, "select name from pragma_index_info('messages_sender_idx')"), ["mailbox_id", "sender_address", "created_at"]);
	assert.deepEqual(names(db, "select name from pragma_table_info('mailbox_promotion_settings')").sort(), ["backfill_cursor", "backfill_day", "backfill_day_rows", "backfill_error", "backfill_scanned", "backfill_stalls", "backfill_status", "mailbox_id", "mode", "updated_at"]);
	assert.deepEqual(names(db, "select name from pragma_table_info('mailbox_sender_preferences')").sort(), ["category_override", "id", "mailbox_id", "sender_address", "unsubscribed_at", "updated_at", "updated_by_user_id"]);
});

test("promotion settings default to off and cascade with the mailbox; sender preferences are unique per sender", () => {
	const db = database();
	db.exec("insert into users (id, email, password_hash, name, created_at) values ('u','u@x.test','h','U',1)");
	db.exec("insert into domains (id, user_id, hostname, zone_id, created_at) values ('d','u','x.test','z',1)");
	db.exec("insert into mailboxes (id, user_id, domain_id, local_part, created_at) values ('m','u','d','a',1)");
	db.exec("insert into mailbox_promotion_settings (mailbox_id, updated_at) values ('m', 1)");
	assert.deepEqual(db.prepare("select mode, backfill_status, backfill_scanned, backfill_stalls from mailbox_promotion_settings").get(), { mode: "off", backfill_status: "idle", backfill_scanned: 0, backfill_stalls: 0 });
	db.exec("insert into mailbox_sender_preferences (id, mailbox_id, sender_address, updated_at) values ('p','m','n@x.test',1)");
	assert.throws(() => db.exec("insert into mailbox_sender_preferences (id, mailbox_id, sender_address, updated_at) values ('q','m','n@x.test',1)"), /UNIQUE/);
	db.exec("delete from mailboxes where id = 'm'");
	assert.equal(db.prepare("select count(*) as n from mailbox_promotion_settings").get().n, 0);
	assert.equal(db.prepare("select count(*) as n from mailbox_sender_preferences").get().n, 0);
});

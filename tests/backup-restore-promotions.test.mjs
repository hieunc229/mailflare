import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules", ".cache", "backup-restore-promotions");
const outfile = join(outDir, "backup.mjs");
await build({
	stdin: {
		contents: 'export * from "./src/lib/backups/export";',
		resolveDir: root,
		loader: "ts",
	},
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const { exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(outfile).href);
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function d1(sqlite) {
	const prepare = (sql) => {
		const statement = {
			values: [],
			bind(...values) {
				statement.values = values;
				return statement;
			},
			async all() {
				return { results: sqlite.prepare(sql).all(...statement.values), success: true, meta: {} };
			},
			async run() {
				const result = sqlite.prepare(sql).run(...statement.values);
				return { results: [], success: true, meta: { changes: result.changes } };
			},
			async first() {
				return sqlite.prepare(sql).get(...statement.values) ?? null;
			},
		};
		return statement;
	};
	return {
		prepare,
		async batch(statements) {
			return Promise.all(statements.map((statement) => statement.run()));
		},
	};
}

function database(beforePromotions = false, stopBefore = null) {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	// Leave out only the promotion migrations: every other column of a newer backup must exist in the target.
	const skipped = new Set([...(beforePromotions ? ["0094_promotions.sql", "0095_promotion_sender_backfill.sql"] : []), ...(stopBefore ? [stopBefore] : [])]);
	for (const migration of migrations.filter((m) => !skipped.has(m.name))) {
		for (const statement of migration.statements) sqlite.exec(statement);
	}
	return sqlite;
}


function seed(sqlite) {
	sqlite.exec("insert into users (id, email, password_hash, name, created_at) values ('u','u@x.test','h','U',1)");
	sqlite.exec("insert into domains (id, user_id, hostname, zone_id, created_at) values ('d','u','x.test','z',1)");
	sqlite.exec("insert into mailboxes (id, user_id, domain_id, local_part, created_at) values ('m','u','d','a',1)");
	sqlite.exec("insert into messages (id, user_id, mailbox_id, direction, status, from_addr, to_addr, subject, created_at) values ('msg','u','m','inbound','received','a@b.test','a@x.test','hi',1)");
}
const toBuffer = (backup) => backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength);
const count = (sqlite, table) => sqlite.prepare(`select count(*) as n from ${table}`).get().n;

test("backup and restore work on a database migrated up to just before promotions", async () => {
	const sqlite = database(true);
	seed(sqlite);
	const backup = await exportDatabaseRecords(d1(sqlite));
	await restoreDatabaseRecords(d1(sqlite), toBuffer(backup));
	assert.equal(count(sqlite, "users"), 1);
	assert.equal(count(sqlite, "messages"), 1);
});

test("a backup written after the promotions migration restores into a database without the promotion migrations without losing mail", async () => {
	const source = database();
	seed(source);
	source.exec("update messages set category = 'promotions', sender_address = 'a@b.test'");
	const backup = await exportDatabaseRecords(d1(source));
	const target = database(true);
	seed(target);
	await restoreDatabaseRecords(d1(target), toBuffer(backup));
	assert.equal(count(target, "users"), 1);
	assert.equal(count(target, "messages"), 1);
});

test("restoring promotion rows into a database without the promotion migrations fails before anything is deleted", async () => {
	const source = database();
	seed(source);
	source.exec("insert into mailbox_promotion_settings (mailbox_id, mode, updated_at) values ('m','show',1)");
	const backup = await exportDatabaseRecords(d1(source));
	const target = database(true);
	seed(target);
	await assert.rejects(restoreDatabaseRecords(d1(target), toBuffer(backup)), /Apply pending database migrations before restoring mailbox_promotion_settings/);
	assert.equal(count(target, "users"), 1);
	assert.equal(count(target, "messages"), 1);
});

test("a backup written after the backfill migration restores into a database that has the promotion tables but not the backfill migration: its new columns are dropped, nothing fails after the delete", async () => {
	const source = database();
	seed(source);
	source.exec("insert into mailbox_promotion_settings (mailbox_id, mode, backfill_status, backfill_stalls, backfill_error, backfill_day, backfill_day_rows, updated_at) values ('m','show','failed',3,'boom',20000,5,1)");
	const backup = await exportDatabaseRecords(d1(source));
	const target = database(false, "0095_promotion_sender_backfill.sql");
	seed(target);
	assert.ok(!target.prepare("pragma table_info(mailbox_promotion_settings)").all().some((column) => column.name === "backfill_stalls"));
	await restoreDatabaseRecords(d1(target), toBuffer(backup));
	assert.deepEqual({ ...target.prepare("select mailbox_id, mode, backfill_status from mailbox_promotion_settings").get() }, { mailbox_id: "m", mode: "show", backfill_status: "failed" });
	assert.equal(count(target, "messages"), 1);
});

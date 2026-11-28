import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The backup constants and the bundled migrations move apart when a migration
 * adds a table, so the test bundles the constants with the esbuild already used
 * by other tests and replays the bundle exactly like `push-devices-migration.test.mjs`.
 */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-backup-table-list-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { BACKUP_TABLES, INTERNAL_TABLES, INTERNAL_TABLE_PATTERNS, assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";`,
		resolveDir: root,
		sourcefile: "backup-table-list-test-entry.js",
	},
	outfile: join(outDir, "backup-list.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { BACKUP_TABLES, INTERNAL_TABLES, INTERNAL_TABLE_PATTERNS, assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords } = await import(
	pathToFileURL(join(outDir, "backup-list.mjs")).href
);

await build({
	stdin: {
		contents: `export { BACKUP_TABLE_GROUPS } from "./src/lib/backups/table-groups.ts";`,
		resolveDir: root,
		sourcefile: "backup-table-groups-test-entry.js",
	},
	outfile: join(outDir, "backup-groups.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { BACKUP_TABLE_GROUPS } = await import(pathToFileURL(join(outDir, "backup-list.mjs")).href.replace("backup-list.mjs", "backup-groups.mjs"));

const bundlePath = join(root, "src/lib/migrations/bundle.json");
if (!existsSync(bundlePath)) spawnSync("node", [join(root, "scripts/generate-migration-bundle.mjs")], { cwd: root });
const { migrations } = JSON.parse(readFileSync(bundlePath, "utf8"));

const db = new Database(":memory:");
db.pragma("foreign_keys = OFF");
for (const migration of migrations) for (const statement of migration.statements) db.exec(statement);
after(() => db.close());

/** A minimal D1Database facade over the migrated in-memory database. */
const d1 = {
	prepare(sql) {
		return { all: async () => ({ results: db.prepare(sql).all() }), first: async () => db.prepare(sql).get() };
	},
};

const isPatternTable = (name) => INTERNAL_TABLE_PATTERNS.some((pattern) => new RegExp(`^${pattern.replaceAll("%", ".*")}$`).test(name));

test("every table in a migrated database is backed up or documented as internal", () => {
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
	const internal = new Set([...INTERNAL_TABLES, ...tables.filter(isPatternTable)]);
	const leftover = tables.filter((name) => !internal.has(name));
	assert.deepEqual(leftover.sort(), [...BACKUP_TABLES].sort());
});

test("the coverage guard passes on a fully migrated database", async () => {
	const covered = await assertBackupTablesCoverDatabase(d1);
	assert.equal(covered.size, BACKUP_TABLES.length);
	for (const table of BACKUP_TABLES) assert.ok(covered.has(table), `${table} is not covered`);
});

test("every backed-up table sits in exactly one group that only holds backed-up tables", () => {
	const assigned = BACKUP_TABLE_GROUPS.flatMap((group) => group.tables);
	const duplicated = BACKUP_TABLES.filter((table) => assigned.filter((item) => item === table).length !== 1);
	const unknown = assigned.filter((table) => !BACKUP_TABLES.includes(table));
	assert.deepEqual([...duplicated, ...unknown], []);
});

test("an unlisted table aborts the backup with a pointing-finger message", async () => {
	const scratch = new Database(":memory:");
	scratch.exec("CREATE TABLE future_table (id TEXT PRIMARY KEY)");
	const scratchD1 = {
		prepare(sql) {
			return { all: async () => ({ results: scratch.prepare(sql).all() }) };
		},
	};
	await assert.rejects(assertBackupTablesCoverDatabase(scratchD1), /future_table not listed in BACKUP_TABLES/);
});

/** Derived: rebuilt from `messages`, never exported, emptied by restore. */
const IMAP_TABLES = ["imap_mailbox_state", "imap_folder_state", "imap_uids", "imap_expunged", "imap_message_cache"];

/** A D1 facade with the calls restore makes, over a migrated in-memory database with foreign keys on. */
function restorableDatabase() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
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
		};
		return statement;
	};
	return { sqlite, d1: { prepare, batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) } };
}

function seedImapState(sqlite) {
	sqlite.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.test', 'x', 'U', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'me', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('g1', 'u1', 'm1', 'inbound', 'a@b.test', 'me@example.test', 'received', 1);
		INSERT INTO imap_mailbox_state (mailbox_id, jmap_seq, modseq) VALUES ('m1', 5, 9);
		INSERT INTO imap_folder_state (id, mailbox_id, folder_key, uidvalidity, uid_next, highest_modseq) VALUES ('m1:inbox', 'm1', 'inbox', 100, 3, 9);
		INSERT INTO imap_uids (mailbox_id, folder_key, uid, message_id, modseq) VALUES ('m1', 'inbox', 1, 'g1', 4), ('m1', 'inbox', 2, 'gone', 5);
		INSERT INTO imap_expunged (mailbox_id, folder_key, uid, modseq) VALUES ('m1', 'inbox', 7, 8);
		INSERT INTO imap_message_flags (message_id, answered, keywords, updated_at) VALUES ('g1', 1, '["$label1"]', 77);
		INSERT INTO imap_message_cache (message_id, size, envelope, bodystructure, header_size) VALUES ('g1', 10, '{}', '{}', 4);
	`);
}

const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("the five derived IMAP tables are internal and never exported; the flags are user data and are", async () => {
	for (const table of IMAP_TABLES) {
		assert.ok(INTERNAL_TABLES.includes(table), `${table} is not internal`);
		assert.ok(!BACKUP_TABLES.includes(table), `${table} is backed up`);
	}
	assert.ok(!INTERNAL_TABLES.includes("imap_message_flags"), "imap_message_flags is user data");
	assert.ok(BACKUP_TABLES.indexOf("imap_message_flags") > BACKUP_TABLES.indexOf("messages"), "flags restore after the messages they point to");
	assert.ok(BACKUP_TABLE_GROUPS.find((group) => group.id === "mail").tables.includes("imap_message_flags"));
	const { sqlite, d1: handle } = restorableDatabase();
	seedImapState(sqlite);
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(handle)));
	for (const table of IMAP_TABLES) assert.equal(document.tables[table], undefined, `${table} leaked into the export`);
	assert.deepEqual(document.tables.imap_message_flags.map((row) => [row.message_id, row.answered, row.keywords]), [["g1", 1, '["$label1"]']]);
});

test("restore clears the derived IMAP tables, including the ones without a foreign key, and keeps the flags", async () => {
	const { sqlite, d1: handle } = restorableDatabase();
	seedImapState(sqlite);
	const backup = await exportDatabaseRecords(handle);
	await restoreDatabaseRecords(handle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(count(sqlite, "messages"), 1, "the mail itself is restored");
	assert.equal(count(sqlite, "imap_message_flags"), 1, "the flags are restored with the mail");
	for (const table of IMAP_TABLES.filter((table) => table !== "imap_folder_state")) assert.equal(count(sqlite, table), 0, `${table} still holds rows after restore`);
});

test("imap_message_flags survive a backup and restore round trip with their message", async () => {
	const { sqlite, d1: handle } = restorableDatabase();
	seedImapState(sqlite);
	sqlite.exec("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('g2', 'u1', 'm1', 'inbound', 'a@b.test', 'me@example.test', 'received', 2)");
	sqlite.exec("INSERT INTO imap_message_flags (message_id, deleted, forwarded) VALUES ('g2', 1, 1)");
	const before = sqlite.prepare("SELECT * FROM imap_message_flags ORDER BY message_id").all();
	const backup = await exportDatabaseRecords(handle);
	await restoreDatabaseRecords(handle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.deepEqual(sqlite.prepare("SELECT * FROM imap_message_flags ORDER BY message_id").all(), before);
	assert.equal(before.length, 2);
});

test("UIDVALIDITY never goes backwards across a restore", async () => {
	const { sqlite, d1: handle } = restorableDatabase();
	seedImapState(sqlite);
	sqlite.exec("INSERT INTO imap_folder_state (id, mailbox_id, folder_key, uidvalidity, uid_next, highest_modseq) VALUES ('m1:sent', 'm1', 'sent', 4000000000, 5, 5)");
	const backup = await exportDatabaseRecords(handle);
	await restoreDatabaseRecords(handle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	const rows = Object.fromEntries(sqlite.prepare("SELECT folder_key, uidvalidity, uid_next, highest_modseq FROM imap_folder_state").all().map((row) => [row.folder_key, row]));
	assert.ok(rows.sent.uidvalidity > 4000000000, "a clock behind the old value cannot lower UIDVALIDITY");
	assert.ok(rows.inbox.uidvalidity > 100);
	assert.equal(rows.sent.uid_next, 1, "the restored folder starts empty");
	assert.equal(count(sqlite, "imap_uids"), 0);
	assert.equal(count(sqlite, "imap_mailbox_state"), 0);
});

test("the UIDVALIDITY carry-over skips mailboxes that no longer exist", async () => {
	const { sqlite, d1: handle } = restorableDatabase();
	seedImapState(sqlite);
	const backup = await exportDatabaseRecords(handle);
	sqlite.pragma("foreign_keys = OFF");
	sqlite.exec("INSERT INTO imap_folder_state (id, mailbox_id, folder_key, uidvalidity, uid_next, highest_modseq) VALUES ('m9:inbox', 'm9', 'inbox', 5, 1, 0)");
	sqlite.pragma("foreign_keys = ON");
	await restoreDatabaseRecords(handle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.deepEqual(sqlite.prepare("SELECT mailbox_id FROM imap_folder_state").all().map((row) => row.mailbox_id), ["m1"]);
});

test("restore still works on a database that has not applied the IMAP migration", async () => {
	const { sqlite, d1: handle } = restorableDatabase();
	seedImapState(sqlite);
	const backup = await exportDatabaseRecords(handle);
	sqlite.pragma("foreign_keys = OFF");
	for (const table of IMAP_TABLES) sqlite.exec(`DROP TABLE ${table}`);
	sqlite.pragma("foreign_keys = ON");
	await restoreDatabaseRecords(handle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(count(sqlite, "messages"), 1);
});

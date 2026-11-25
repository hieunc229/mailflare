import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules", ".cache", "backup-restore-passkeys");
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

function database() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) {
		for (const statement of migration.statements) sqlite.exec(statement);
	}
	return sqlite;
}

function addUser(sqlite) {
	sqlite.prepare(
		`INSERT INTO users (
			id, email, password_hash, name, role, is_primary_admin, disabled, can_manage_mailboxes,
			can_manage_domains, can_manage_users, keyboard_shortcuts_enabled, spam_protection_enabled,
			show_full_recipient_addresses, remote_content_mode, require_second_factor, totp_enabled, created_at
		) VALUES ('u1', 'u1@example.test', '!passkey-only', 'User', 'user', 0, 0, 0, 0, 0, 1, 1, 0, 'allow', 0, 0, 1)`,
	).run();
	sqlite.prepare(
		`INSERT INTO passkey_credentials (id, user_id, credential_id, credential_hash, public_key, counter, device_type, backed_up, name, created_at)
		 VALUES ('p1', 'u1', 'c1', 'h1', 'key', 0, 'singleDevice', 0, 'Test', 1)`,
	).run();
}

test("a backup with a passwordless passkey restores without tripping the last-method guard", async () => {
	const sqlite = database();
	addUser(sqlite);
	const databaseHandle = d1(sqlite);
	const backup = await exportDatabaseRecords(databaseHandle);
	assert.equal(sqlite.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 1);

	await restoreDatabaseRecords(databaseHandle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get().count, 1);
	assert.equal(sqlite.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 1);
});

test("a newer backup restores into a database that has the passkey table but not the aaguid column", async () => {
	const source = database();
	addUser(source);
	source.prepare("UPDATE passkey_credentials SET aaguid = 'test-aaguid' WHERE id = 'p1'").run();
	const backup = await exportDatabaseRecords(d1(source));

	// Simulates an installation whose passkey table predates the aaguid column.
	const target = database();
	target.exec("ALTER TABLE passkey_credentials DROP COLUMN aaguid");
	await restoreDatabaseRecords(d1(target), backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(target.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get().count, 1);
	assert.equal(target.prepare("PRAGMA table_info(passkey_credentials)").all().some((column) => column.name === "aaguid"), false);
});

test("a backup from before private_draft restores drafts as private, derived like the migration backfill", async () => {
	const source = database();
	addUser(source);
	source.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'team', 'shared', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES
			('draft', 'u1', 'mb1', 'outbound', 'team@example.test', 'x@example.net', 'draft', 1),
			('moved', 'u1', 'mb1', 'outbound', 'team@example.test', 'x@example.net', 'trash', 2),
			('sent-trashed', 'u1', 'mb1', 'outbound', 'team@example.test', 'x@example.net', 'trash', 3),
			('sent', 'u1', 'mb1', 'outbound', 'team@example.test', 'x@example.net', 'sent', 4),
			('inbound', 'u1', 'mb1', 'inbound', 'x@example.net', 'team@example.test', 'trash', 5);
		INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, created_at, updated_at) VALUES ('j1', 'u1', 'sent-trashed', 'sent', '{}', 1, 1);`);
	const backup = await exportDatabaseRecords(d1(source));
	const document = JSON.parse(new TextDecoder().decode(backup));
	for (const row of document.tables.messages) delete row.private_draft;
	const old = new TextEncoder().encode(JSON.stringify(document));

	const target = database();
	await restoreDatabaseRecords(d1(target), old.buffer.slice(old.byteOffset, old.byteOffset + old.byteLength));
	const flags = Object.fromEntries(target.prepare("SELECT id, private_draft AS p FROM messages").all().map((row) => [row.id, row.p]));
	assert.deepEqual(flags, { draft: 1, moved: 1, "sent-trashed": 0, sent: 0, inbound: 0 });
});

test("a restore clears the DAV change log and sync state so clients resync from a new epoch", async () => {
	const sqlite = database();
	addUser(sqlite);
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'u1', 't', 1, 2, 1, 1)").run();
	sqlite.prepare("INSERT INTO dav_sync_state (collection_id, epoch, floor) VALUES ('cal:u1', 'old-epoch', 0)").run();
	sqlite.prepare("INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:u1', 'ghost', 'updated')").run();
	const databaseHandle = d1(sqlite);
	const backup = await exportDatabaseRecords(databaseHandle);
	await restoreDatabaseRecords(databaseHandle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM dav_sync_state").get().count, 0);
	assert.deepEqual(sqlite.prepare("SELECT object_key AS k, change_type AS t FROM dav_changes ORDER BY seq").all(), [{ k: "e1", t: "created" }]);
});

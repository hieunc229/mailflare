import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules", ".cache", "backup-ephemeral-tables");
const outfile = join(outDir, "backup.mjs");
await build({
	stdin: {
		contents: 'export * from "./src/lib/backups/export"; export { BACKUP_TABLE_GROUPS } from "./src/lib/backups/table-groups";',
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
const { exportDatabaseRecords, restoreDatabaseRecords, BACKUP_TABLES, EPHEMERAL_TABLES } = await import(pathToFileURL(outfile).href);
const { BACKUP_TABLE_GROUPS } = await import(pathToFileURL(outfile).href);
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


function seed(sqlite) {
	sqlite.exec("insert into users (id, email, password_hash, name, created_at) values ('u','u@x.test','h','U',1)");
	sqlite.exec("insert into domains (id, user_id, hostname, zone_id, created_at) values ('d','u','x.test','z',1)");
	sqlite.exec("insert into mailboxes (id, user_id, domain_id, local_part, created_at) values ('m','u','d','a',1)");
	sqlite.exec("insert into messages (id, user_id, mailbox_id, direction, status, from_addr, to_addr, subject, created_at) values ('msg','u','m','inbound','received','a@b.test','a@x.test','hi',1)");
}
const toBuffer = (backup) => backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength);
const count = (sqlite, table) => sqlite.prepare(`select count(*) as n from ${table}`).get().n;



const NAMES = ["sessions", "password_reset_tokens", "login_challenges"];
const addSession = (sqlite) => sqlite.exec("insert into sessions (id, user_id, token_hash, expires_at, created_at) values ('s1','u','hash-live',9999999999,1)");

test("ephemeral tables are not backed up and not in any group", () => {
	for (const name of NAMES) {
		assert.ok(!BACKUP_TABLES.includes(name), `${name} in BACKUP_TABLES`);
		assert.ok(EPHEMERAL_TABLES.includes(name), `${name} missing from EPHEMERAL_TABLES`);
		assert.ok(!BACKUP_TABLE_GROUPS.some((group) => group.tables.includes(name)), `${name} in a group`);
	}
});

test("an export carries no session rows", async () => {
	const source = database();
	seed(source);
	addSession(source);
	const doc = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(source))));
	for (const name of NAMES) {
		assert.equal(doc.tables[name], undefined, name);
		assert.ok(!doc.includedTables.includes(name), name);
	}
});

test("an old document with ephemeral tables restores, ignores their rows and signs everyone out", async () => {
	const source = database();
	seed(source);
	const doc = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(source))));
	doc.includedTables.push(...NAMES);
	doc.tables.sessions = [{ id: "old", user_id: "u", token_hash: "revoked-after-backup", expires_at: 9999999999, created_at: 1 }];
	doc.tables.password_reset_tokens = [];
	doc.tables.login_challenges = [];
	const target = database();
	seed(target);
	addSession(target);
	assert.equal(count(target, "sessions"), 1);
	await restoreDatabaseRecords(d1(target), new TextEncoder().encode(JSON.stringify(doc)).buffer);
	assert.equal(count(target, "sessions"), 0);
	assert.equal(count(target, "users"), 1);
});

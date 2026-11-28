import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules", ".cache", "backup-restore-column-drift");
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


function seed(sqlite) {
	sqlite.exec("insert into users (id, email, password_hash, name, created_at) values ('u','u@x.test','h','U',1)");
	sqlite.exec("insert into domains (id, user_id, hostname, zone_id, created_at) values ('d','u','x.test','z',1)");
	sqlite.exec("insert into mailboxes (id, user_id, domain_id, local_part, created_at) values ('m','u','d','a',1)");
	sqlite.exec("insert into messages (id, user_id, mailbox_id, direction, status, from_addr, to_addr, subject, created_at) values ('msg','u','m','inbound','received','a@b.test','a@x.test','hi',1)");
}
const toBuffer = (backup) => backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength);
const count = (sqlite, table) => sqlite.prepare(`select count(*) as n from ${table}`).get().n;


async function backupWith(mutate) {
	const source = database();
	seed(source);
	const doc = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(source))));
	mutate(doc);
	return new TextEncoder().encode(JSON.stringify(doc)).buffer;
}

test("a column the live schema lacks is dropped on restore for a table with no special case", async () => {
	const buffer = await backupWith((doc) => { for (const row of doc.tables.mailboxes) row.future_column = "x"; });
	const target = database();
	seed(target);
	await restoreDatabaseRecords(d1(target), buffer);
	assert.equal(count(target, "mailboxes"), 1);
	assert.equal(target.prepare("select local_part from mailboxes").get().local_part, "a");
});

test("the same holds for domains and the users table", async () => {
	const buffer = await backupWith((doc) => {
		for (const row of doc.tables.domains) row.future_column = "x";
		for (const row of doc.tables.users) row.future_column = "x";
	});
	const target = database();
	seed(target);
	await restoreDatabaseRecords(d1(target), buffer);
	assert.equal(count(target, "domains"), 1);
	assert.equal(count(target, "users"), 1);
});

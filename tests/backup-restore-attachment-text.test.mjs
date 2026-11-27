import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules", ".cache", "backup-restore-attachment-text");
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

const EXTRACTION_MIGRATION = "0108_attachment_extraction.sql";

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

function database({ beforeExtraction = false } = {}) {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations.filter((candidate) => !(beforeExtraction && candidate.name === EXTRACTION_MIGRATION))) {
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
const attachmentColumns = (sqlite) => sqlite.prepare("pragma table_info(message_attachments)").all().map((column) => column.name);

test("a backup carrying extracted attachment text restores into a database without that migration", async () => {
	const source = database();
	seed(source);
	source.exec("insert into message_attachments (id, message_id, filename, content_type, size, r2_key, created_at, extracted_text, extract_status, extracted_at) values ('att','msg','a.txt','text/plain',5,'k1',1,'hello','done',2)");
	const backup = await exportDatabaseRecords(d1(source));

	const target = database({ beforeExtraction: true });
	seed(target);
	assert.ok(!attachmentColumns(target).includes("extracted_text"), "the target has not applied the migration");

	await restoreDatabaseRecords(d1(target), toBuffer(backup));
	assert.equal(count(target, "messages"), 1);
	const restored = target.prepare("select id, filename, r2_key from message_attachments").get();
	assert.deepEqual({ ...restored }, { id: "att", filename: "a.txt", r2_key: "k1" }, "the attachment survives without the extracted-text columns");
});

test("the same backup into a migrated database keeps the extracted text", async () => {
	const source = database();
	seed(source);
	source.exec("insert into message_attachments (id, message_id, filename, content_type, size, r2_key, created_at, extracted_text, extract_status, extracted_at) values ('att','msg','a.txt','text/plain',5,'k1',1,'hello','done',2)");
	const backup = await exportDatabaseRecords(d1(source));

	const target = database();
	seed(target);
	await restoreDatabaseRecords(d1(target), toBuffer(backup));
	assert.deepEqual({ ...target.prepare("select extracted_text as text, extract_status as status from message_attachments").get() }, { text: "hello", status: "done" });
});

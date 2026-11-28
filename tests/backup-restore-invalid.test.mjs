import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-backup-invalid-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: { contents: 'export * from "./src/lib/backups/export";', resolveDir: root, loader: "ts" },
	outfile: join(outDir, "backup.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const { exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(outDir, "backup.mjs")).href);
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function d1(sqlite) {
	const prepare = (sql) => {
		const statement = {
			values: [],
			bind(...values) { statement.values = values; return statement; },
			async all() { return { results: sqlite.prepare(sql).all(...statement.values), success: true, meta: {} }; },
			async run() { const result = sqlite.prepare(sql).run(...statement.values); return { results: [], success: true, meta: { changes: result.changes } }; },
			async first() { return sqlite.prepare(sql).get(...statement.values) ?? null; },
		};
		return statement;
	};
	return { prepare, async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } };
}

function database() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	sqlite.exec(`
		INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'me', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'a@example.net', 'me@example.test', 'received', 1);`);
	return sqlite;
}

const count = (sqlite, table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const encode = (value) => { const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };

async function rejectsWithoutTouchingRows(content, message) {
	const sqlite = database();
	// Every table the export covers, so a change to any of them shows.
	const tables = Object.keys(JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite)))).tables);
	const counts = () => Object.fromEntries(tables.map((table) => [table, count(sqlite, table)]));
	const before = counts();
	await assert.rejects(restoreDatabaseRecords(d1(sqlite), content), message);
	assert.deepEqual(counts(), before);
	assert.deepEqual([before.users, before.messages], [1, 1]);
}

test("a document that is not JSON is rejected and no rows change", async () => {
	await rejectsWithoutTouchingRows(encode("{not json"), /not a valid Mailflare backup/);
});

test("a table row that is not an object is rejected before any delete", async () => {
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(database()))));
	document.tables.domains = [1];
	await rejectsWithoutTouchingRows(encode(document), /invalid domains record/);
});

test("a document that leaves out a table group is rejected before any delete", async () => {
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(database()))));
	document.includedTables = ["users"];
	await rejectsWithoutTouchingRows(encode(document), /selected table groups only/);
});

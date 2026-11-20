import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-backup-dmarc-"));
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
	sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', 1)").run();
	sqlite.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1)").run();
	sqlite.prepare("INSERT INTO dmarc_daily_stats (id, domain_id, day, row_key, source_ip, reporter_org, header_from, disposition, dkim_aligned, spf_aligned, message_count) VALUES (41, 'd1', '2025-11-18', 'k', '203.0.113.7', 'google.com', 'example.test', 'none', 1, 1, 9)").run();
	return sqlite;
}

const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test("dmarc_daily_stats is backed up without its serial id, so a PostgreSQL restore cannot leave the sequence behind the rows", async () => {
	const sqlite = database();
	const backup = await exportDatabaseRecords(d1(sqlite));
	const document = JSON.parse(new TextDecoder().decode(backup));
	assert.equal(document.tables.dmarc_daily_stats.length, 1);
	assert.equal("id" in document.tables.dmarc_daily_stats[0], false);
	assert.equal(document.tables.dmarc_daily_stats[0].message_count, 9);
});

test("restoring ignores an id in the stats rows (older documents) and keeps the data", async () => {
	const sqlite = database();
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
	document.tables.dmarc_daily_stats[0].id = 9000;
	await restoreDatabaseRecords(d1(sqlite), buffer(new TextEncoder().encode(JSON.stringify(document))));
	const [row] = sqlite.prepare("SELECT id, message_count FROM dmarc_daily_stats").all();
	assert.equal(row.message_count, 9);
	assert.notEqual(row.id, 9000);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-backup-tls-"));
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

function database(stop = migrations.length) {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations.slice(0, stop)) for (const statement of migration.statements) sqlite.exec(statement);
	sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', 1)").run();
	sqlite.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1)").run();
	return sqlite;
}

const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test("MTA-STS settings, report kind and tls_daily_stats round-trip, the serial id is left out", async () => {
	const sqlite = database();
	sqlite.prepare("INSERT INTO domain_deliverability (domain_id, updated_at, tls_rpt_enabled, mta_sts_mode, mta_sts_policy_id, mta_sts_mx, mta_sts_max_age) VALUES ('d1', 1, 1, 'testing', '20251118000000', '[\"mx.example.test\"]', 86400)").run();
	sqlite.prepare("INSERT INTO deliverability_reports (id, domain_id, kind, report_key, received_at) VALUES ('r1', 'd1', 'tlsrpt', 'k', 1)").run();
	sqlite.prepare("INSERT INTO tls_daily_stats (id, domain_id, day, row_key, reporter_org, policy_type, result_type, success_count, failure_count) VALUES (77, 'd1', '2025-11-18', 'k', 'google.com', 'sts', '', 5, 0)").run();
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
	assert.equal(document.tables.tls_daily_stats.length, 1);
	assert.equal("id" in document.tables.tls_daily_stats[0], false);
	assert.deepEqual(document.includedTables.includes("tls_daily_stats"), true);
	await restoreDatabaseRecords(d1(sqlite), buffer(new TextEncoder().encode(JSON.stringify(document))));
	assert.equal(sqlite.prepare("SELECT success_count FROM tls_daily_stats").get().success_count, 5);
	assert.equal(sqlite.prepare("SELECT mta_sts_policy_id FROM domain_deliverability").get().mta_sts_policy_id, "20251118000000");
	assert.equal(sqlite.prepare("SELECT kind FROM deliverability_reports").get().kind, "tlsrpt");
});

test("a backup from a newer database restores onto one that has not applied the MTA-STS migration yet", async () => {
	const newer = database();
	newer.prepare("INSERT INTO domain_deliverability (domain_id, updated_at, mta_sts_mode) VALUES ('d1', 1, 'none')").run();
	newer.prepare("INSERT INTO deliverability_reports (id, domain_id, kind, report_key, received_at) VALUES ('r1', 'd1', 'dmarc', 'k', 1)").run();
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(newer))));
	const older = database(migrations.findIndex((migration) => migration.name.startsWith("0101_")));
	assert.equal(older.prepare("SELECT count(*) AS n FROM pragma_table_info('domain_deliverability') WHERE name = 'mta_sts_mode'").get().n, 0);
	await restoreDatabaseRecords(d1(older), buffer(new TextEncoder().encode(JSON.stringify(document))));
	assert.equal(older.prepare("SELECT count(*) AS n FROM domain_deliverability").get().n, 1);
	assert.equal(older.prepare("SELECT count(*) AS n FROM deliverability_reports").get().n, 1);
});

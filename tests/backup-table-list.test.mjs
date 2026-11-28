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
		contents: `export { BACKUP_TABLES, EPHEMERAL_TABLES, INTERNAL_TABLES, INTERNAL_TABLE_PATTERNS, assertBackupTablesCoverDatabase } from "./src/lib/backups/export.ts";`,
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

const { BACKUP_TABLES, EPHEMERAL_TABLES, INTERNAL_TABLES, INTERNAL_TABLE_PATTERNS, assertBackupTablesCoverDatabase } = await import(
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
	assert.deepEqual(leftover.sort(), [...BACKUP_TABLES, ...EPHEMERAL_TABLES].sort());
});

test("the coverage guard passes on a fully migrated database", async () => {
	const covered = await assertBackupTablesCoverDatabase(d1);
	assert.equal(covered.size, BACKUP_TABLES.length + EPHEMERAL_TABLES.length);
	for (const table of [...BACKUP_TABLES, ...EPHEMERAL_TABLES]) assert.ok(covered.has(table), `${table} is not covered`);
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

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-drive-items-indexes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function plan(sql) {
	const database = new SqliteDatabase(":memory:");
	try {
		await applyMigrations(database, join(root, "drizzle/migrations"));
		return database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join(" ");
	} finally {
		database.db.close();
	}
}

test("drive_items has an index on r2_key", async () => {
	assert.match(await plan("SELECT id FROM drive_items WHERE r2_key IN ('a','b')"), /drive_items_r2_key_idx/);
});

test("drive_items has an index on parent_id", async () => {
	assert.match(await plan("SELECT id FROM drive_items WHERE parent_id IN ('a','b')"), /drive_items_parent_idx/);
});

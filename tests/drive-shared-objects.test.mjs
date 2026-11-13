import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-shared-objects-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { findReferencedKeys } from "./src/lib/drive/shared-objects.ts";
		`,
		resolveDir: root,
		sourcefile: "shared-objects-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, findReferencedKeys } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("findReferencedKeys keeps every statement under D1's 100 bound parameters", async (t) => {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const counts = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			counts.push(values.length);
			return bind(...values);
		};
		return statement;
	};
	const db = getDb({ DB: database });
	const keys = Array.from({ length: 150 }, (_, index) => `k${index}`);
	const ids = Array.from({ length: 150 }, (_, index) => `i${index}`);
	const referenced = await findReferencedKeys(db, keys, { driveItemIds: ids, attachmentIds: ids });
	assert.equal(referenced.size, 0);
	assert.ok(counts.length > 0);
	assert.ok(Math.max(...counts) <= 100, `max params ${Math.max(...counts)}`);
});

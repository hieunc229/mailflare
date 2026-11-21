import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-database-errors-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		errors: join(root, "src/lib/database-errors.ts"),
		tracking: join(root, "src/lib/tracking/open-tracking.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
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
const { isMissingColumnError, isMissingTableError, isUniqueConstraintError } = await load("errors");
const { getOpenCounts } = await load("tracking");
const { SqliteDatabase } = await load("database");

test("driver errors are found through drizzle's wrapper", () => {
	const wrapped = new Error("Failed query: select 1\nparams: ", { cause: new Error("no such table: message_tracking") });
	assert.equal(isMissingTableError(wrapped), true);
	assert.equal(isMissingTableError(new Error("D1_ERROR: no such table: x: SQLITE_ERROR")), true);
	assert.equal(isMissingTableError(new Error("Failed query", { cause: new Error("database is locked") })), false);
	assert.equal(isUniqueConstraintError(new Error("Failed query", { cause: new Error("UNIQUE constraint failed: domain_tracking_hosts.hostname") })), true);
	assert.equal(isUniqueConstraintError(new Error("no such table")), false);
});

test("missing column wording per dialect", () => {
	for (const message of [
		"no such column: messages.new_col",
		"table messages has no column named new_col",
		'column "new_col" of relation "messages" does not exist',
		"column messages.new_col does not exist",
		"Unknown column 'new_col' in 'field list'",
	]) assert.equal(isMissingColumnError(new Error("Failed query", { cause: new Error(message) })), true, message);
	assert.equal(isMissingColumnError(new Error("column reference \"id\" is ambiguous")), false);
	assert.equal(isMissingColumnError(new Error("syntax error")), false);
});

test("driver error codes win over the message", () => {
	const coded = (props) => new Error("Failed query", { cause: Object.assign(new Error("localised or reworded"), props) });
	assert.equal(isMissingColumnError(coded({ code: "42703" })), true);
	assert.equal(isMissingTableError(coded({ code: "42P01" })), true);
	assert.equal(isMissingColumnError(coded({ errno: 1054 })), true);
	assert.equal(isMissingColumnError(coded({ code: "ER_BAD_FIELD_ERROR" })), true);
	assert.equal(isMissingTableError(coded({ errno: 1146 })), true);
	assert.equal(isMissingTableError(coded({ code: "ER_NO_SUCH_TABLE" })), true);
	assert.equal(isMissingTableError(coded({ code: "42703" })), false);
	assert.equal(isMissingColumnError(coded({ code: "42P01" })), false);
	assert.equal(isMissingColumnError(coded({ code: "23505" })), false);
});

test("message lists with sent mail keep working before migration 0068", async (t) => {
	const database = new SqliteDatabase(join(outDir, "empty.sqlite"));
	t.after(() => database.db.close());
	const counts = await getOpenCounts({ DB: database }, ["m1"]);
	assert.equal(counts.size, 0);
});

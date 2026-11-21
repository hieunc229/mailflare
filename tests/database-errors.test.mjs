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
const { isMissingTableError, isUniqueConstraintError, isRetryableConflictError } = await load("errors");
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

test("message lists with sent mail keep working before migration 0068", async (t) => {
	const database = new SqliteDatabase(join(outDir, "empty.sqlite"));
	t.after(() => database.db.close());
	const counts = await getOpenCounts({ DB: database }, ["m1"]);
	assert.equal(counts.size, 0);
});

test("write conflicts that a retry resolves are told apart from other failures", () => {
	const wrap = (cause) => new Error("Failed query: insert", { cause });
	const coded = (message, props) => Object.assign(new Error(message), props);
	assert.equal(isRetryableConflictError(wrap(new Error("UNIQUE constraint failed: imap_uids.uid"))), true);
	assert.equal(isRetryableConflictError(wrap(new Error('duplicate key value violates unique constraint "x"'))), true);
	assert.equal(isRetryableConflictError(wrap(new Error("Duplicate entry '1' for key 'x'"))), true);
	assert.equal(isRetryableConflictError(wrap(coded("could not serialize access due to concurrent update", { code: "40001" }))), true);
	assert.equal(isRetryableConflictError(wrap(coded("anything", { code: "40001" }))), true);
	assert.equal(isRetryableConflictError(wrap(coded("deadlock detected", { code: "40P01" }))), true);
	assert.equal(isRetryableConflictError(wrap(coded("Deadlock found when trying to get lock; try restarting transaction", { errno: 1213, code: "ER_LOCK_DEADLOCK" }))), true);
	assert.equal(isRetryableConflictError(wrap(coded("anything", { errno: 1213 }))), true);
	assert.equal(isRetryableConflictError(wrap(coded("Lock wait timeout exceeded; try restarting transaction", { errno: 1205, code: "ER_LOCK_WAIT_TIMEOUT" }))), true);
	assert.equal(isRetryableConflictError(new Error("no such table: imap_uids")), false);
	assert.equal(isRetryableConflictError(wrap(coded("syntax error", { code: "42601" }))), false);
	assert.equal(isRetryableConflictError(wrap(coded("database is locked", { code: "SQLITE_BUSY" }))), false);
	assert.equal(isRetryableConflictError("nope"), false);
});

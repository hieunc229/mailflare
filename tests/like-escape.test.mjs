import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-like-escape-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { sql } from "drizzle-orm";
			export { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
			export { containsLike, insensitiveLike, escapeLike } from "./src/db/sql.ts";
		`,
		resolveDir: root,
		sourcefile: "like-entry.ts",
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
const { sql, SQLiteSyncDialect, containsLike, insensitiveLike, escapeLike } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const ROWS = ["no_reply@x.com", "noXreply@x.com", "Q3_report", "Q3Xreport", "100% sure", "1000 sure", "wow!", "Plain"];

function matches(build) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("create table t (v text)");
	for (const value of ROWS) sqlite.prepare("insert into t values (?)").run(value);
	const query = new SQLiteSyncDialect().sqlToQuery(sql`select v from t where ${build(sql`v`)} order by v`);
	return sqlite.prepare(query.sql).all(...query.params).map((row) => row.v);
}

test("contains matches take _ % and ! literally", () => {
	assert.deepEqual(matches((column) => containsLike(column, "no_reply@x.com")), ["no_reply@x.com"]);
	assert.deepEqual(matches((column) => containsLike(column, "Q3_report")), ["Q3_report"]);
	assert.deepEqual(matches((column) => containsLike(column, "100%")), ["100% sure"]);
	assert.deepEqual(matches((column) => containsLike(column, "wow!")), ["wow!"]);
});

test("contains matches ignore case", () => {
	assert.deepEqual(matches((column) => containsLike(column, "PLAIN")), ["Plain"]);
});

test("insensitiveLike honours the ! escape that escapeLike emits", () => {
	assert.deepEqual(matches((column) => insensitiveLike(column, `%${escapeLike("_report")}`)), ["Q3_report"]);
});

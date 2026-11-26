import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-search-negation-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/search/query-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { buildFtsMatch, parseSearchQuery } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

function run(query) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE VIRTUAL TABLE f USING fts5(subject)");
	db.exec("INSERT INTO f(subject) VALUES ('newsletter weekly'), ('invoice due'), ('hello there')");
	const { match, exclude } = buildFtsMatch(parseSearchQuery(query, "UTC"));
	const sql = match
		? "SELECT subject FROM f WHERE rowid IN (SELECT rowid FROM f WHERE f MATCH ?)"
		: "SELECT subject FROM f WHERE rowid NOT IN (SELECT rowid FROM f WHERE f MATCH ?)";
	return db.prepare(sql).all(match ?? exclude).map((row) => row.subject);
}

test("a negation-only search excludes the term and keeps everything else", () => {
	assert.deepEqual(run("-newsletter").sort(), ["hello there", "invoice due"]);
});

test("positive terms with a negation still use the combined MATCH", () => {
	assert.deepEqual(run("-newsletter hello"), ["hello there"]);
});

test("a query with no text terms has nothing to match", () => {
	assert.deepEqual(buildFtsMatch(parseSearchQuery("is:unread", "UTC")), { match: null, exclude: null });
});

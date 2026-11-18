import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-query-params-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/api/query-params.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { parseLimit, parseOffset } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("parseLimit clamps to the max and falls back on junk, zero and negatives", () => {
	assert.equal(parseLimit(null, 50, 100), 50);
	assert.equal(parseLimit("20", 50, 100), 20);
	assert.equal(parseLimit("5000", 50, 100), 100);
	for (const value of ["-1", "0", "abc", "", "1.5", "NaN", "Infinity"]) assert.equal(parseLimit(value, 50, 100), 50, value);
});

test("parseOffset is a non-negative integer", () => {
	assert.equal(parseOffset(null), 0);
	assert.equal(parseOffset("30"), 30);
	for (const value of ["-5", "abc", "", "2.5"]) assert.equal(parseOffset(value), 0, value);
});

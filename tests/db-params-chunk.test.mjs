import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "tests", ".tmp-db-params-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: { p: join(root, "src/lib/db-params.ts"), c: join(root, "src/lib/calendar/chunks.ts") }, outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { chunk } = await import(pathToFileURL(join(dir, "p.mjs")).href);
const { chunkIds } = await import(pathToFileURL(join(dir, "c.mjs")).href);

test("chunk splits a list at the given size", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
	assert.deepEqual(chunk([], 3), []);
	assert.deepEqual(chunk([1], 90), [[1]]);
});

test("the default size is a D1-safe IN list of 90, as chunkIds always used", () => {
	const ids = Array.from({ length: 200 }, (_, index) => `id${index}`);
	assert.deepEqual(chunk(ids).map((part) => part.length), [90, 90, 20]);
	assert.deepEqual(chunkIds(ids), chunk(ids));
});

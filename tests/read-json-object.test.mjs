import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-read-json-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/http/request.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { readJsonObject } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const post = (body) => new Request("https://mail.test/api", { method: "POST", body });

test("readJsonObject returns the parsed object", async () => {
	assert.deepEqual(await readJsonObject(post('{"a":1}')), { a: 1 });
});

test("readJsonObject returns null for empty, malformed and non-object bodies", async () => {
	for (const body of ["", "{oops", "null", "[1]", '"text"', "7"]) assert.equal(await readJsonObject(post(body)), null, body);
});

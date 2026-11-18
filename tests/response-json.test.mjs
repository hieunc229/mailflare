import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-response-json-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/http/response.ts")],
	outfile: join(directory, "response.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
});
const { readResponseJson } = await import(pathToFileURL(join(directory, "response.mjs")).href);

test("JSON objects pass through", async () => {
	assert.deepEqual(await readResponseJson(new Response('{"error":"x"}')), { error: "x" });
});

test("an HTML error page or empty body becomes an empty object", async () => {
	assert.deepEqual(await readResponseJson(new Response("<html>502</html>", { status: 502 })), {});
	assert.deepEqual(await readResponseJson(new Response("")), {});
	assert.deepEqual(await readResponseJson(new Response("null")), {});
});

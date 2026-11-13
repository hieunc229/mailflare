import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-routing-rule-cache-"));
const realFetch = globalThis.fetch;
after(() => { rmSync(outDir, { recursive: true, force: true }); globalThis.fetch = realFetch; });
await build({
	stdin: { contents: "export * from './src/lib/cloudflare-api';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "api.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const api = await import(pathToFileURL(join(outDir, "api.mjs")).href);

test("addresses of one operation share a single rules listing per zone", async () => {
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const method = init.method ?? "GET";
		calls.push(`${method} ${new URL(String(url)).pathname}`);
		const result = method === "GET" ? [] : { id: "new-rule" };
		return new Response(JSON.stringify({ success: true, errors: [], result, result_info: { total_pages: 1 } }));
	};
	const cache = new Map();
	const env = { CF_TOKEN: "token" };
	await Promise.all(["a", "b", "c", "d"].map((name) => api.ensureEmailRoutingRuleToWorker(env, "zone", `${name}@example.com`, undefined, cache)));
	assert.equal(calls.filter((call) => call.startsWith("GET")).length, 1);
	assert.equal(calls.filter((call) => call.startsWith("POST")).length, 4);
});

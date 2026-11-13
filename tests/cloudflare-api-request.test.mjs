import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-cloudflare-api-"));
const realFetch = globalThis.fetch;
after(() => { rmSync(outDir, { recursive: true, force: true }); globalThis.fetch = realFetch; });
await build({
	stdin: { contents: "export * from './src/lib/cloudflare-api';export { CloudflareApiError } from './src/lib/cloudflare-api-error';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "api.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const api = await import(pathToFileURL(join(outDir, "api.mjs")).href);
const env = { CF_TOKEN: "token" };

const reply = (body, init = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), init);

test("a non-JSON error page becomes a CloudflareApiError", async () => {
	globalThis.fetch = async () => reply("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" });
	await assert.rejects(api.getZone(env, "zone"), (error) => error instanceof api.CloudflareApiError && error.status === 502);
});

test("requests carry a timeout signal", async () => {
	let signal;
	globalThis.fetch = async (_url, init) => {
		signal = init.signal;
		return reply({ success: true, errors: [], result: { id: "zone", name: "example.com" } });
	};
	await api.getZone(env, "zone");
	assert.ok(signal instanceof AbortSignal);
});

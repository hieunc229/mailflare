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

test("listEmailRoutingRules reads every page", async () => {
	const rules = Array.from({ length: 120 }, (_, index) => ({ id: `rule${index}` }));
	const urls = [];
	globalThis.fetch = async (url) => {
		urls.push(String(url));
		const parsed = new URL(String(url));
		const page = Number(parsed.searchParams.get("page") ?? 1);
		const perPage = Number(parsed.searchParams.get("per_page") ?? 20);
		return reply({ success: true, errors: [], result: rules.slice((page - 1) * perPage, page * perPage), result_info: { page, per_page: perPage, total_pages: Math.ceil(rules.length / perPage) } });
	};
	const result = await api.listEmailRoutingRules(env, "zone");
	assert.equal(result.length, 120);
	assert.equal(new Set(result.map((rule) => rule.id)).size, 120);
	assert.ok(urls.every((url) => url.includes("per_page=50")));
});

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

test("a list longer than the page cap throws instead of returning a partial list", async () => {
	globalThis.fetch = async (url) => {
		const page = Number(new URL(String(url)).searchParams.get("page"));
		return reply({ success: true, errors: [], result: [{ id: `rule${page}` }], result_info: { page, per_page: 50, total_pages: 1000 } });
	};
	await assert.rejects(api.listEmailRoutingRules(env, "zone"), /more than \d+ pages/);
});

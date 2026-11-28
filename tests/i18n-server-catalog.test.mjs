import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-i18n-server-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// `fetchAsset` is swapped per test; getEnv() hands the server module an ASSETS fetcher that calls it.
globalThis.__assetsFetch = async () => new Response("{}");
const stubs = {
	name: "stubs",
	setup(b) {
		b.onResolve({ filter: /^next\/headers$/ }, () => ({ path: "next-headers", namespace: "stub" }));
		b.onResolve({ filter: /^@\/lib\/cloudflare$/ }, () => ({ path: "cloudflare", namespace: "stub" }));
		b.onLoad({ filter: /^next-headers$/, namespace: "stub" }, () => ({ contents: "export const cookies = async () => ({ get: () => undefined });", loader: "js" }));
		b.onLoad({ filter: /^cloudflare$/, namespace: "stub" }, () => ({ contents: "export const getEnv = () => ({ ASSETS: { fetch: (...args) => globalThis.__assetsFetch(...args) } });", loader: "js" }));
	},
};
await build({
	entryPoints: [join(root, "src/lib/i18n/server.ts")],
	outfile: join(directory, "server.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	plugins: [stubs],
	logLevel: "silent",
});
const { loadServerMessages } = await import(pathToFileURL(join(directory, "server.mjs")).href);

test("loads each locale catalog once", async () => {
	let calls = 0;
	globalThis.__assetsFetch = async () => { calls += 1; return new Response(JSON.stringify({ hello: "Hallo" })); };
	const first = await loadServerMessages("de");
	const second = await loadServerMessages("de");
	assert.deepEqual(first, { hello: "Hallo" });
	assert.equal(second, first);
	assert.equal(calls, 1);
});

test("retries after a failed load", async () => {
	let calls = 0;
	const originalWarn = console.warn;
	console.warn = () => {};
	globalThis.__assetsFetch = async () => { calls += 1; if (calls === 1) throw new Error("ASSETS down"); return new Response(JSON.stringify({ hello: "Bonjour" })); };
	try {
		assert.equal(await loadServerMessages("fr"), undefined);
		assert.deepEqual(await loadServerMessages("fr"), { hello: "Bonjour" });
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(calls, 2);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "remote-route-test-"));
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.proxyAuth; delete globalThis.proxyEnv; delete globalThis.proxyFetch; });
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.proxyEnv}",
	"@/lib/api/auth": "export async function requireSessionUser(){return globalThis.proxyAuth}",
	"@/lib/remote-images/fetch": "export class RemoteImageError extends Error { constructor(message,status){super(message);this.status=status} } export function fetchRemoteImage(...args){return globalThis.proxyFetch(...args)}",
};
await build({ entryPoints: [join(project, "src/app/api/remote-images/route.ts")], outfile: join(temporary, "route.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", alias: { "@": join(project, "src") }, logLevel: "silent", plugins: [{ name: "route-fixtures", setup(builder) {
	builder.onResolve({ filter: /^@\/lib\/(cloudflare|api\/auth|remote-images\/fetch)$/ }, args => ({ path: args.path, namespace: "mock" }));
	builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path], loader: "js" }));
} }] });
const { GET } = await import(pathToFileURL(join(temporary, "route.mjs")).href);
const request = () => new Request("https://mail.example/api/remote-images?url=https%3A%2F%2Fcdn.example%2Flogo.png");

test("unauthenticated requests never make outbound proxy requests", async () => {
	globalThis.proxyEnv = {};
	globalThis.proxyFetch = () => { throw new Error("Unexpected outbound request"); };
	globalThis.proxyAuth = { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
	assert.equal((await GET(request())).status, 401);
});

test("the self-hosted runtime proxies images too, and one user is rate limited", async () => {
	globalThis.proxyAuth = { user: { id: "node-user" }, error: null };
	globalThis.proxyEnv = { MAILFLARE_RUNTIME: "node" };
	globalThis.proxyFetch = async () => ({ body: new Uint8Array([1]), contentType: "image/png" });
	assert.equal((await GET(request())).status, 200);
	let limited = 0;
	for (let index = 0; index < 400; index += 1) if ((await GET(request())).status === 429) limited += 1;
	assert.ok(limited > 0);
	globalThis.proxyAuth = { user: { id: "someone-else" }, error: null };
	assert.equal((await GET(request())).status, 200);
});

test("authenticated Worker responses use private image headers and block the app origin", async () => {
	globalThis.proxyAuth = { user: { id: "user" }, error: null };
	globalThis.proxyEnv = {};
	globalThis.proxyFetch = async (url, options) => {
		assert.equal(url, "https://cdn.example/logo.png");
		assert.deepEqual(options.blockedOrigins, ["https://mail.example"]);
		return { body: new Uint8Array([1, 2, 3]), contentType: "image/png" };
	};
	const response = await GET(request());
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
	assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
	assert.equal(response.headers.get("Content-Type"), "image/png");
	assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

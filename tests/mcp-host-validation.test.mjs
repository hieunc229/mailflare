import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "mcp-host-test-"));
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.mcpEnv; delete globalThis.mcpPrincipal; delete globalThis.mcpAllow; delete globalThis.mcpCalls; });
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.mcpEnv}",
	"@/lib/mcp/auth": "export async function authenticateMcpRequest(){return globalThis.mcpPrincipal}",
	"@/lib/mcp/server": "export function createMailflareMcpHandler(env, principal, origin, authorization){ globalThis.mcpCalls.push({ env, principal, origin, authorization }); return { fetch: () => new Response('ok'), close: async () => {} }; }",
	"@/lib/agent/rate-limit": "export async function allowAgentRequest(){return globalThis.mcpAllow}",
};
await build({ entryPoints: [join(project, "src/app/mcp/route.ts")], outfile: join(temporary, "route.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", alias: { "@": join(project, "src") }, logLevel: "silent", plugins: [{ name: "route-fixtures", setup(builder) {
	builder.onResolve({ filter: /^@\/lib\/(cloudflare|mcp\/auth|mcp\/server|agent\/rate-limit)$/ }, args => ({ path: args.path, namespace: "mock" }));
	builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path], loader: "js" }));
} }] });
const { POST } = await import(pathToFileURL(join(temporary, "route.mjs")).href);

const request = (url, headers = {}) => new Request(url, { method: "POST", headers });
const setup = (env) => {
	globalThis.mcpEnv = env;
	globalThis.mcpPrincipal = { keyId: "key" };
	globalThis.mcpAllow = true;
	globalThis.mcpCalls = [];
};

test("APP_URL set: a forwarded host matching APP_URL is accepted and gets the public origin", async () => {
	setup({ APP_URL: "https://mail.example.com" });
	const response = await POST(request("http://127.0.0.1:3000/mcp", { "x-forwarded-host": "mail.example.com", Host: "mail.example.com" }));
	assert.equal(response.status, 200);
	assert.equal(globalThis.mcpCalls.length, 1);
	assert.equal(globalThis.mcpCalls[0].origin, "https://mail.example.com");
});

test("APP_URL set: a non-matching host is still rejected", async () => {
	setup({ APP_URL: "https://mail.example.com" });
	const response = await POST(request("http://127.0.0.1:3000/mcp", { Host: "evil.example" }));
	assert.equal(response.status, 403);
	assert.deepEqual(globalThis.mcpCalls, []);
});

test("APP_URL set: the reconstructed host still matches", async () => {
	setup({ APP_URL: "https://mail.example.com" });
	const response = await POST(request("https://mail.example.com/mcp"));
	assert.equal(response.status, 200);
	assert.equal(globalThis.mcpCalls[0].origin, "https://mail.example.com");
});

test("APP_URL set: the first entry of a forwarded-host list wins", async () => {
	setup({ APP_URL: "https://mail.example.com" });
	const response = await POST(request("http://127.0.0.1:3000/mcp", { "x-forwarded-host": "mail.example.com, proxy.internal" }));
	assert.equal(response.status, 200);
	assert.equal(globalThis.mcpCalls[0].origin, "https://mail.example.com");
});

test("APP_URL unset: any host is accepted and the reconstructed origin is used", async () => {
	setup({});
	const response = await POST(request("http://127.0.0.1:3000/mcp", { Host: "anything.example" }));
	assert.equal(response.status, 200);
	assert.equal(globalThis.mcpCalls[0].origin, "http://127.0.0.1:3000");
});

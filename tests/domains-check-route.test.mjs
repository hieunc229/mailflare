import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "tests", ".tmp-domains-check-"));
const realFetch = globalThis.fetch;
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.checkEnv; globalThis.fetch = realFetch; });
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.checkEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return {id:'user'}}",
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
};
await build({ entryPoints: [join(project, "src/app/api/domains/check/route.ts")], outfile: join(temporary, "route.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", alias: { "@": join(project, "src") }, logLevel: "silent", plugins: [{ name: "route-fixtures", setup(builder) {
	builder.onResolve({ filter: /^@\/lib\/(cloudflare|auth\/cookies)$|^next\/server$/ }, args => ({ path: args.path, namespace: "mock" }));
	builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path], loader: "js" }));
} }] });
const { POST } = await import(pathToFileURL(join(temporary, "route.mjs")).href);

const post = (body) => POST(new Request("http://localhost/api/domains/check", { method: "POST", body: JSON.stringify(body) }));

test("without Cloudflare credentials the check answers with a manual zone instead of failing", async () => {
	globalThis.checkEnv = {};
	globalThis.fetch = async () => { throw new Error("must not call the Cloudflare API"); };
	const response = await post({ hostname: "Example.com" });
	assert.equal(response.status, 200);
	assert.deepEqual((await response.json()).domain.zone.name, "example.com");
});

test("skipDns answers with a manual zone even when credentials exist", async () => {
	globalThis.checkEnv = { CF_TOKEN: "token" };
	globalThis.fetch = async () => { throw new Error("must not call the Cloudflare API"); };
	const response = await post({ hostname: "example.com", skipDns: true });
	assert.equal(response.status, 200);
});

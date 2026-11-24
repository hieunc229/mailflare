import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-force-route-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const mocks = {
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
	"drizzle-orm": "export const eq=()=>({})",
	"@/db": "export const getDb=()=>({})",
	"@/db/schema": "export const domains={}",
	"@/lib/cloudflare": "export const getEnv=()=>({})",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.__user}",
	"@/lib/auth/origin": "export const hasValidSessionMutationOrigin=()=>true",
	"@/lib/deliverability/mta-sts-block-response": "export async function mtaStsBlockedResponse(){return null}",
	"@/lib/domains/service": "export const dnsSkippedUpdate=()=>({});export const getDomainForUser=async()=>null;export async function removeDomainForUser(env,userId,id,force){globalThis.__calls.push(force);if(force&&force.confirm!=='example.com')throw Object.assign(new Error('Type the domain name'),{status:400});return {leftovers:[{name:'_mta-sts.example.com',type:'TXT'}],cachedUntil:'2026-01-01T00:00:00.000Z'}}",
};
const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
await build({
	entryPoints: [join(root, "src/app/api/domains/[id]/route.ts")], outfile: join(outDir, "route.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", alias: { "@": join(root, "src") }, logLevel: "silent",
	plugins: [{ name: "mock-deps", setup(builder) {
		builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
	} }],
});
const { DELETE } = await import(pathToFileURL(join(outDir, "route.mjs")).href);
const del = (body) => DELETE(new Request("http://localhost/api/domains/d1", { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id: "d1" }) });
const admin = { id: "u1", role: "admin", isPrimaryAdmin: true, canManageDomains: true };

test("a forced delete is for admins who can manage domains: others get 403 and nothing runs", async () => {
	globalThis.__calls = [];
	for (const user of [{ id: "u2", role: "user", isPrimaryAdmin: false, canManageDomains: false }, { id: "u3", role: "admin", isPrimaryAdmin: false, canManageDomains: false }]) {
		globalThis.__user = user;
		assert.equal((await del({ force: true, confirm: "example.com" })).status, 403);
	}
	assert.deepEqual(globalThis.__calls, []);
});

test("force and the typed confirmation reach the service; a wrong confirmation is a 400; a plain delete is not forced", async () => {
	globalThis.__user = admin;
	globalThis.__calls = [];
	assert.equal((await del({ force: true, confirm: "nope" })).status, 400);
	assert.equal((await del({ force: true })).status, 400);
	const forced = await del({ force: true, confirm: "example.com" });
	assert.equal(forced.status, 200);
	assert.deepEqual(await forced.json(), { ok: true, leftovers: [{ name: "_mta-sts.example.com", type: "TXT" }], cachedUntil: "2026-01-01T00:00:00.000Z" });
	for (const body of [undefined, {}, { force: "yes", confirm: "example.com" }]) {
		globalThis.__calls = [];
		assert.deepEqual(await (await del(body)).json(), { ok: true });
		assert.deepEqual(globalThis.__calls, [undefined]);
	}
});

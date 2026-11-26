import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// An admin who cannot manage users still gets the account list (it feeds
// pickers) but not other people's recovery addresses.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-accounts-list-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const mocks = {
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
	"drizzle-orm": "export const eq=()=>0,and=()=>0,desc=()=>0,inArray=()=>0;",
	"@/db/schema": "const c=new Proxy({}, {get:(_,k)=>String(k)});export const users=c,domains=c,mailboxes=c;",
	"@/db": "const rows={from(){return rows},orderBy(){return Promise.resolve([{id:'u2',email:'b@example.com',name:'B',resetEmail:'private@example.org',role:'user',disabled:false,createdAt:new Date(0)}])}};export function getDb(){return {select(){return rows}}}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.__actor}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canManageAccounts:true,accountSeatLimit:null}}",
	"@/lib/licenses/seats": "export async function countUsedAccountSeats(){return 1}",
	"@/lib/accounts/deletion": "export async function deleteAccounts(){}",
	"./create": "export async function createAccountResponse(){}",
};
await build({
	entryPoints: [join(root, "src/app/api/accounts/route.ts")],
	outfile: join(outDir, "route.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mock-deps",
		setup(builder) {
			const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
			builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const { GET } = await import(pathToFileURL(join(outDir, "route.mjs")).href);
const list = async (actor) => {
	globalThis.__actor = actor;
	return (await GET(new Request("http://localhost/api/accounts"))).json();
};

test("an admin without the manage-users permission does not see recovery addresses", async () => {
	const body = await list({ id: "a1", role: "admin", isPrimaryAdmin: false, canManageUsers: false });
	assert.equal(body.accounts.length, 1);
	assert.equal("resetEmail" in body.accounts[0], false);
});

test("an admin who manages users and the primary admin still see them", async () => {
	for (const actor of [{ id: "a1", role: "admin", isPrimaryAdmin: false, canManageUsers: true }, { id: "a0", role: "admin", isPrimaryAdmin: true, canManageUsers: false }]) {
		assert.equal((await list(actor)).accounts[0].resetEmail, "private@example.org");
	}
});

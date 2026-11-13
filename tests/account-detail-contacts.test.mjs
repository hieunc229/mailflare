import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The account detail response includes the forwarding address only for admins who manage users.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-account-detail-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const mocks = {
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
	"drizzle-orm": "export const eq=()=>0;",
	"@/db/schema": "const c=new Proxy({}, {get:(_,k)=>String(k)});export const users=c;",
	"@/db": "export function getDb(){return {}}",
	"../utils": "export async function requireTeamAdmin(){return {env:{},user:globalThis.__actor}}",
	"./utils": "export const selectAccountById=async()=>({id:'u2',email:'b@example.com',name:'B',role:'user',isPrimaryAdmin:false,disabled:false,forwardingEmail:'private@example.org',passwordHash:'x'});export class AccountSecurityChangedError extends Error{};export class PasskeyOnlyPasswordError extends Error{};export const updateAccountCredentials=async()=>{};",
	"@/lib/licenses/seats": "export async function getAccountSeatError(){return null}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canForwardEmail:true}}",
	"@/lib/auth/session": "export async function deleteUserSessions(){}export function getSessionTokenFromRequestHeaders(){return null}",
	"@/lib/auth/password": "export const hasPasswordHash=()=>true;",
	"@/lib/auth/webauthn/grants": "export async function consumeStepUpGrant(){}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/http/auth-error": "export const authError=()=>new Response(null,{status:400});",
};
await build({
	entryPoints: [join(root, "src/app/api/accounts/[id]/route.ts")],
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
const detail = async (actor) => {
	globalThis.__actor = actor;
	return (await GET(new Request("http://localhost/api/accounts/u2"), { params: Promise.resolve({ id: "u2" }) })).json();
};

test("an admin without the manage-users permission does not get the forwarding address", async () => {
	const body = await detail({ id: "a1", role: "admin", isPrimaryAdmin: false, canManageUsers: false });
	assert.equal(body.account.id, "u2");
	assert.equal("forwardingEmail" in body.account, false);
});

test("an admin who manages users still gets it", async () => {
	const body = await detail({ id: "a1", role: "admin", isPrimaryAdmin: false, canManageUsers: true });
	assert.equal(body.account.forwardingEmail, "private@example.org");
});

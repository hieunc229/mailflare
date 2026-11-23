import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "tests", ".tmp-malformed-json-"));
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.malformedActor; delete globalThis.malformedAccount; });

// A malformed JSON body must be a 400, not an unhandled parse throw that becomes a 500.
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return {id:'user',role:'admin',isPrimaryAdmin:true}}",
	"@/lib/domains/preflight": "export async function preflightSetupDomain(){throw new Error('must not reach the domain preflight')}",
	"@/app/api/accounts/utils": "export async function requireTeamAdmin(){return {env:{},user:globalThis.malformedActor,error:null}} export async function requireTeamSharingAdmin(){return {env:{},user:{id:'admin'},error:null}}",
	"accounts/[id]/utils": "export class AccountSecurityChangedError extends Error{} export class PasskeyOnlyPasswordError extends Error{} export async function selectAccountById(){return globalThis.malformedAccount} export async function updateAccountCredentials(){return {}}",
	"@/db": "export function getDb(){return globalThis.malformedDb}",
	"@/db/schema": "export const users={};export const mailboxAccess={};export const mailboxes={};",
	"@/lib/auth/admin": "export function isPrimaryAdmin(u){return !!u?.isPrimaryAdmin} export function canManageUsers(u){return !!u?.canManageUsers} export function canManageUserAccount(){return true} export function assertAdmin(){}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/auth/session": "export function deleteUserSessions(){} export function getSessionTokenFromRequestHeaders(){return 'tok'}",
	"@/lib/auth/password": "export function hasPasswordHash(){return false} export async function hashPassword(){return ''}",
	"@/lib/auth/webauthn/grants": "export async function bumpSecurityVersion(){} export async function consumeStepUpGrant(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/http/auth-error": "export function authError(code,status){return Response.json({error:code},{status})}",
	"@/lib/licenses/seats": "export async function getAccountSeatError(){return null}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canForwardEmail:true}}",
};

await build({
	stdin: {
		contents: `export * as domainCheck from './src/app/api/domains/check/route';export * as mailboxAccess from './src/app/api/mailboxes/[id]/access/route';export * as account from './src/app/api/accounts/[id]/route';`,
		resolveDir: project,
		loader: "ts",
	},
	outfile: join(temporary, "routes.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(project, "src") },
	plugins: [{ name: "malformed-body-mocks", setup(builder) {
		builder.onResolve({ filter: /.*/ }, (args) => {
			let key = args.path;
			// `./utils` inside accounts/[id]/route.ts is that folder's own utils; every
			// other `./utils` (mailboxes access route) bundles for real.
			if (args.path === "./utils" && args.importer.includes("accounts/[id]/")) key = "accounts/[id]/utils";
			// `../utils` from accounts/[id]/route.ts is src/app/api/accounts/utils, the
			// same module the mailbox access route imports as @/app/api/accounts/utils.
			else if (args.path === "../utils" && args.importer.includes("accounts/[id]/")) key = "@/app/api/accounts/utils";
			return key in mocks ? { path: key, namespace: "mock" } : undefined;
		});
		builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
	} }],
	logLevel: "silent",
});
const { domainCheck, mailboxAccess, account } = await import(pathToFileURL(join(temporary, "routes.mjs")).href);

const badJson = "{not valid json";
const post = (path) => new Request(`https://mail.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: badJson });
const patch = (path) => new Request(`https://mail.test${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: badJson });
const context = (id) => ({ params: Promise.resolve({ id }) });

test("POST /api/domains/check answers 400 for a malformed JSON body", async () => {
	const response = await domainCheck.POST(post("/api/domains/check"));
	assert.equal(response.status, 400);
});

test("POST /api/mailboxes/[id]/access answers 400 for a malformed JSON body", async () => {
	const response = await mailboxAccess.POST(post("/api/mailboxes/m-1/access"), context("m-1"));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "Choose a valid account");
});

test("PATCH /api/accounts/[id] answers 400 for a malformed JSON body", async () => {
	globalThis.malformedActor = { id: "admin", role: "admin", isPrimaryAdmin: true };
	globalThis.malformedAccount = { id: "acc-1", role: "user" };
	const response = await account.PATCH(patch("/api/accounts/acc-1"), context("acc-1"));
	assert.equal(response.status, 400);
});

test("schema-invalid but well-formed JSON keeps its existing 400", async () => {
	globalThis.malformedActor = { id: "admin", role: "admin", isPrimaryAdmin: true };
	globalThis.malformedAccount = { id: "acc-1", role: "user" };
	const validJson = (path, method) => new Request(`https://mail.test${path}`, { method, headers: { "Content-Type": "application/json" }, body: "{}" });
	assert.equal((await domainCheck.POST(validJson("/api/domains/check", "POST"))).status, 400);
	assert.equal((await mailboxAccess.POST(validJson("/api/mailboxes/m-1/access", "POST"), context("m-1"))).status, 400);
	assert.equal((await account.PATCH(validJson("/api/accounts/acc-1", "PATCH"), context("acc-1"))).status, 400);
});

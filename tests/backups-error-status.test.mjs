import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "backups-status-"));
after(() => {
	rmSync(temporary, { recursive: true, force: true });
	delete globalThis.backupsTest;
});
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return {BUCKET:{get:async()=>{throw new Error('r2 down')}}}}",
	"@/db": "export function getDb(){return {select(){return {from(){return {where(){return {limit:async()=>{throw new Error('db down')}}}}}}}}}",
	"@/lib/auth/cookies": "import {UnauthorizedError} from '@/lib/auth/unauthorized'; export async function requireUser(){ if(globalThis.backupsTest.sessionFails) throw new Error('db down'); if(!globalThis.backupsTest.user) throw new UnauthorizedError(); return globalThis.backupsTest.user }",
	"@/lib/backups/export": "export function getBackupConfigurationStatus(){return {}}",
	"@/lib/backups/runner": "export async function runDatabaseBackup(){}",
	"@/lib/backups/service": "const fail=async()=>{throw new Error('db down')}; export const createBackupRecord=fail,getBackupSettings=fail,listBackups=fail,updateBackupSettings=fail,deleteBackup=fail;",
};
await build({
	stdin: {
		contents: `export * as list from './src/app/api/backups/route';export * as item from './src/app/api/backups/[id]/route';export * as download from './src/app/api/backups/[id]/download/route';`,
		resolveDir: project,
		loader: "ts",
	},
	outfile: join(temporary, "routes.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(project, "src") },
	plugins: [{
		name: "mocks",
		setup(builder) {
			builder.onResolve({ filter: /^(next\/server|@\/db|@\/lib\/(cloudflare|auth\/cookies|backups\/(export|runner|service)))$/ }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js", resolveDir: project }));
		},
	}],
	logLevel: "silent",
});
const { list, item, download } = await import(pathToFileURL(join(temporary, "routes.mjs")).href);
const admin = { id: "a", role: "admin", isPrimaryAdmin: true };
const request = (method = "GET", body) => new Request("https://mail.test/api/backups", { method, ...(body === undefined ? {} : { body }) });
const context = { params: Promise.resolve({ id: "b1" }) };

test("only auth failures are 401/403", async () => {
	globalThis.backupsTest = { user: null };
	assert.equal((await list.GET(request())).status, 401);
	globalThis.backupsTest = { user: { id: "u", role: "user", isPrimaryAdmin: false } };
	for (const response of [await list.GET(request()), await list.PUT(request("PUT", "{}")), await item.DELETE(request("DELETE"), context), await download.GET(request(), context)]) {
		assert.equal(response.status, 403);
	}
});

test("a malformed body is 400 and backend failures are 500, never 403", async () => {
	globalThis.backupsTest = { user: admin };
	assert.equal((await list.PUT(request("PUT", "not json"))).status, 400);
	assert.equal((await list.GET(request())).status, 500);
	assert.equal((await item.DELETE(request("DELETE"), context)).status, 500);
	assert.equal((await download.GET(request(), context)).status, 500);
});

test("a failing session lookup is not reported as an auth answer", async () => {
	globalThis.backupsTest = { user: admin, sessionFails: true };
	await assert.rejects(list.GET(request()), /db down/);
	await assert.rejects(item.DELETE(request("DELETE"), context), /db down/);
});

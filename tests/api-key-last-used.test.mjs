import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// lastUsedAt is written at most once a minute per key.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-api-key-last-used-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mocks = {
	"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});export const and=(...a)=>({and:a});export const or=(...a)=>({or:a});export const lt=(c,v)=>({lt:[c,v]});export const isNull=(c)=>({isNull:c});",
	"@/db/schema": "export const apiKeys={};export const mcpKeyMailboxes={};export const users={};",
	"@/db": "const rows={from(){return rows},where(){return rows},limit(){return Promise.resolve([globalThis.__user])},then(resolve){resolve([])}};export function getDb(env){return {select(){return rows},update(){globalThis.__updates++;return {set(values){globalThis.__sets.push(values);return {where(){return Promise.resolve()}}}}}}}",
	"@/lib/api/find-api-key": "export async function findApiKeyForSecret(db){return {id:'key1',userId:'u1',kind:'api',scopes:'[]',mailboxScopeEnabled:false,lastUsedAt:globalThis.__lastUsedAt}}",
	"@/lib/api-keys": "export const parseScopes=()=>[]",
	"@/lib/api/scopes": "export const ADMIN_API_KEY_SCOPES=[]",
};
await build({
	stdin: { contents: "export { authenticateApiKeyValue } from './src/lib/api/key-auth';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "auth.mjs"),
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
const { authenticateApiKeyValue } = await import(pathToFileURL(join(outDir, "auth.mjs")).href);

beforeEach(() => {
	globalThis.__updates = 0;
	globalThis.__sets = [];
	globalThis.__user = { id: "u1", email: "a@example.com", disabled: false };
});

const usage = { protocol: "imap", ip: "203.0.113.5" };

test("a key used within a minute is not written again", async () => {
	globalThis.__lastUsedAt = new Date(Date.now() - 10_000);
	const result = await authenticateApiKeyValue({ DB: "db" }, "ep_key", { usage });
	assert.equal(result?.userId, "u1");
	assert.equal(globalThis.__updates, 0);
});

test("a key last used two minutes ago is written with its usage record", async () => {
	globalThis.__lastUsedAt = new Date(Date.now() - 120_000);
	await authenticateApiKeyValue({ DB: "db" }, "ep_key", { usage });
	assert.equal(globalThis.__updates, 1);
	assert.equal(globalThis.__sets[0].lastUsedProtocol, "imap");
	assert.equal(globalThis.__sets[0].lastUsedIp, "203.0.113.5");
});

test("a key never used is written", async () => {
	globalThis.__lastUsedAt = null;
	await authenticateApiKeyValue({ DB: "db" }, "ep_key", { usage });
	assert.equal(globalThis.__updates, 1);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Authentication reads go to the primary so a revoked key or disabled account
// is not honoured by a lagging read replica (same rule as session auth).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-api-key-primary-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mocks = {
	"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});export const and=(...a)=>({and:a});export const or=(...a)=>({or:a});export const lt=(c,v)=>({lt:[c,v]});export const isNull=(c)=>({isNull:c});",
	"@/db/schema": "export const apiKeys={};export const mcpKeyMailboxes={};export const users={};",
	"@/db": "const rows={from(){return rows},where(){return rows},limit(){return Promise.resolve([globalThis.__user])},then(resolve){resolve([])}};export function getDb(env){globalThis.__dbEnvs.push(env.DB);return {select(){return rows},update(){return {set(){return {where(){return Promise.resolve()}}}}}}}",
	"@/lib/api/find-api-key": "export async function findApiKeyForSecret(db){return {id:'key1',userId:'u1',kind:'api',scopes:'[]',mailboxScopeEnabled:false}}",
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
	globalThis.__dbEnvs = [];
	globalThis.__user = { id: "u1", email: "a@example.com", disabled: false };
});

test("API key authentication reads through the primary database", async () => {
	const result = await authenticateApiKeyValue({ DB: "replica-session", DB_PRIMARY: "primary" }, "ep_key");
	assert.equal(result?.userId, "u1");
	assert.deepEqual([...new Set(globalThis.__dbEnvs)], ["primary"]);
});

test("without a separate primary binding the normal database is used", async () => {
	await authenticateApiKeyValue({ DB: "only" }, "ep_key");
	assert.deepEqual([...new Set(globalThis.__dbEnvs)], ["only"]);
});

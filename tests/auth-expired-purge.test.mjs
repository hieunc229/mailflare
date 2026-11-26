import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-auth-purge-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const mocks = {
	"drizzle-orm": "export const lt=(c,v)=>({lt:[c,v]});export const inArray=(c,v)=>({inArray:[c,v]});",
	"@/db/schema": "const t=(n)=>({__name:n,id:n+'.id',expiresAt:n+'.expiresAt'});export const sessions=t('sessions'),loginChallenges=t('login_challenges'),passwordResetTokens=t('password_reset_tokens'),passkeyEnrollmentGrants=t('passkey_enrollment_grants');",
	"@/db": `export function getDb(){return {
		select(){return {from(table){return {where(condition){return {limit(n){
			globalThis.__selects.push({table:table.__name,condition,limit:n});
			const left=globalThis.__expired[table.__name]??0;
			const take=Math.min(left,n);
			globalThis.__expired[table.__name]=left-take;
			return Promise.resolve(Array.from({length:take},(_,i)=>({id:table.__name+i})));
		}}}}}}},
		delete(table){return {where(condition){globalThis.__deletes.push({table:table.__name,ids:condition.inArray[1]});if(globalThis.__failOn===table.__name)return Promise.reject(new Error('boom'));return Promise.resolve()}}}
	}}`,
};
await build({
	stdin: { contents: "export { purgeExpiredAuthRows } from './src/lib/auth/purge';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "purge.mjs"),
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
const { purgeExpiredAuthRows } = await import(pathToFileURL(join(outDir, "purge.mjs")).href);

const setup = (expired) => { globalThis.__selects = []; globalThis.__deletes = []; globalThis.__expired = { ...expired }; globalThis.__failOn = undefined; };
const rowsDeleted = (table) => globalThis.__deletes.filter((entry) => entry.table === table).reduce((sum, entry) => sum + entry.ids.length, 0);

test("only rows that expired before now are selected, per table", async () => {
	setup({ sessions: 3, login_challenges: 1, password_reset_tokens: 2, passkey_enrollment_grants: 1 });
	const now = new Date("2026-01-01T00:00:00Z");
	await purgeExpiredAuthRows({}, now);
	assert.deepEqual([...new Set(globalThis.__selects.map((entry) => entry.table))], ["sessions", "login_challenges", "password_reset_tokens", "passkey_enrollment_grants"]);
	for (const { table, condition } of globalThis.__selects) assert.deepEqual(condition, { lt: [`${table}.expiresAt`, now] });
	assert.equal(rowsDeleted("sessions"), 3);
	assert.equal(rowsDeleted("passkey_enrollment_grants"), 1);
});

test("deletes go in batches of at most 90 ids and stop at the per-run cap", async () => {
	setup({ sessions: 1_000_000 });
	await purgeExpiredAuthRows({}, new Date());
	const sessionDeletes = globalThis.__deletes.filter((entry) => entry.table === "sessions");
	assert.equal(sessionDeletes.length, 50);
	assert.ok(sessionDeletes.every((entry) => entry.ids.length === 90));
});

test("a failing table does not stop the others", async () => {
	setup({ sessions: 5, login_challenges: 5 });
	globalThis.__failOn = "sessions";
	const originalError = console.error;
	console.error = () => {};
	try { await purgeExpiredAuthRows({}, new Date()); } finally { console.error = originalError; }
	assert.equal(rowsDeleted("login_challenges"), 5);
});

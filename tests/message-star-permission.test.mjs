import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-message-star-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const mocks = {
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
	"drizzle-orm": "export const eq=()=>0;",
	"@/db/schema": "export const messages={id:'id',mailboxId:'mailboxId',starred:'starred'};",
	"@/db": "const rows={from(){return rows},where(){return rows},limit(){return Promise.resolve([{id:'m1',mailboxId:'mb1',starred:false}])}};export function getDb(){return {select(){return rows},update(){return {set(values){return {where(){globalThis.__updates.push(values)}}}}}}}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return {id:'u1'}}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/mailboxes/access": "export async function getMailboxAccessLevel(){return globalThis.__access}",
};
await build({
	entryPoints: [join(root, "src/app/api/messages/[messageId]/star/route.ts")],
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
const { POST } = await import(pathToFileURL(join(outDir, "route.mjs")).href);
const toggle = () => POST(new Request("http://localhost/star", { method: "POST" }), { params: Promise.resolve({ messageId: "m1" }) });

beforeEach(() => { globalThis.__updates = []; });

test("a read-only delegate cannot change the shared star flag", async () => {
	globalThis.__access = { canRead: true, canSendOnBehalf: false, canManage: false };
	assert.equal((await toggle()).status, 403);
	assert.deepEqual(globalThis.__updates, []);
});

test("a delegate with write access can star", async () => {
	globalThis.__access = { canRead: true, canSendOnBehalf: true, canManage: false };
	const response = await toggle();
	assert.equal(response.status, 200);
	assert.deepEqual(globalThis.__updates, [{ starred: true }]);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "folder-client-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(project, "src/lib/folders/client.ts")],
	outfile: join(directory, "client.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
	plugins: [{ name: "mock-auth", setup(builder) {
		builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
			contents: `export const AUTH_SESSION_CHANGED_EVENT = "auth-changed"; export function getClientSessionToken(){return globalThis.sessionToken ?? null;} export function authFetch(...args){return globalThis.folderFetch(...args);}`,
			loader: "js",
		}));
	} }],
});
const clientUrl = pathToFileURL(join(directory, "client.mjs")).href;
let client;
let dom;
let now;
let originalNow;

function response(folders = []) { return { ok: true, json: async () => ({ folders }) }; }
async function setup() {
	dom = new JSDOM("<!doctype html>");
	globalThis.window = dom.window;
	globalThis.sessionToken = "account-a";
	globalThis.folderFetch = async (_url, options) => { assert.equal(options.cache, "no-store"); return response([{ id: "f1" }]); };
	originalNow = Date.now;
	now = 1_000;
	Date.now = () => now;
	client = await import(`${clientUrl}?run=${Math.random()}`);
}
function cleanup() {
	Date.now = originalNow;
	dom.window.close();
	delete globalThis.window;
	delete globalThis.sessionToken;
	delete globalThis.folderFetch;
}

test("concurrent callers share one no-store fetch and successful data hits the short cache", async () => {
	await setup();
	try {
		let calls = 0;
		globalThis.folderFetch = async () => { calls++; await Promise.resolve(); return response([{ id: "f1" }]); };
		const [a, b] = await Promise.all([client.getMailboxFolders("mb1"), client.getMailboxFolders("mb1")]);
		assert.deepEqual(a, b);
		assert.equal(calls, 1);
		await client.getMailboxFolders("mb1");
		assert.equal(calls, 1);
	} finally { cleanup(); }
});

test("cache expires after 15 seconds", async () => {
	await setup();
	try {
		let calls = 0;
		globalThis.folderFetch = async () => { calls++; return response(); };
		await client.getMailboxFolders("mb1");
		now += 15_001;
		await client.getMailboxFolders("mb1");
		assert.equal(calls, 2);
	} finally { cleanup(); }
});

test("cache evicts its oldest entry after 32 mailbox entries", async () => {
	await setup();
	try {
		let calls = 0;
		globalThis.folderFetch = async () => { calls++; return response(); };
		for (let index = 0; index < 33; index++) await client.getMailboxFolders(`mb${index}`);
		await client.getMailboxFolders("mb0");
		assert.equal(calls, 34);
	} finally { cleanup(); }
});

test("session and event invalidation reject stale responses without disturbing a newer request", async () => {
	await setup();
	try {
		let resolveOld;
		globalThis.folderFetch = () => new Promise(resolve => { resolveOld = resolve; });
		const old = client.getMailboxFolders("mb1");
		await Promise.resolve();
		globalThis.sessionToken = "account-b";
		window.dispatchEvent(new window.Event("auth-changed"));
		let resolveNew;
		globalThis.folderFetch = () => new Promise(resolve => { resolveNew = resolve; });
		const fresh = client.getMailboxFolders("mb1");
		await Promise.resolve();
		resolveOld(response([{ id: "old" }]));
		await assert.rejects(old, /invalidated/);
		resolveNew(response([{ id: "new" }]));
		assert.deepEqual((await fresh).folders, [{ id: "new" }]);
		assert.deepEqual((await client.getMailboxFolders("mb1")).folders, [{ id: "new" }]);
	} finally { cleanup(); }
});

test("messages and folders events invalidate in-flight and cached data", async () => {
	await setup();
	try {
		let calls = 0;
		globalThis.folderFetch = async () => { calls++; return response([{ id: String(calls) }]); };
		await client.getMailboxFolders("mb1");
		window.dispatchEvent(new window.Event("mailflare:messages-changed"));
		await client.getMailboxFolders("mb1");
		window.dispatchEvent(new window.Event("mailflare:folders-changed"));
		await client.getMailboxFolders("mb1");
		assert.equal(calls, 3);
	} finally { cleanup(); }
});

test("pending callers receive fresh folders after a messages event", async () => {
	await setup();
	try {
		const resolvers = [];
		globalThis.folderFetch = () => new Promise(resolve => { resolvers.push(resolve); });
		const first = client.getMailboxFolders("mb1");
		const second = client.getMailboxFolders("mb1");
		assert.equal(resolvers.length, 1);
		window.dispatchEvent(new window.Event("mailflare:messages-changed"));
		resolvers[0](response([{ id: "stale" }]));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(resolvers.length, 2);
		resolvers[1](response([{ id: "fresh" }]));
		assert.deepEqual((await first).folders, [{ id: "fresh" }]);
		assert.deepEqual((await second).folders, [{ id: "fresh" }]);
		assert.equal(resolvers.length, 2);
	} finally { cleanup(); }
});

for (const invalidation of ["mailflare:folders-changed", "explicit invalidation"]) {
	test(`pending caller retries after ${invalidation}`, async () => {
		await setup();
		try {
			const resolvers = [];
			globalThis.folderFetch = () => new Promise(resolve => { resolvers.push(resolve); });
			const pending = client.getMailboxFolders("mb1");
			if (invalidation === "explicit invalidation") client.invalidateFolderCache();
			else window.dispatchEvent(new window.Event(invalidation));
			resolvers[0](response([{ id: "stale" }]));
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(resolvers.length, 2);
			resolvers[1](response([{ id: "fresh" }]));
			assert.deepEqual((await pending).folders, [{ id: "fresh" }]);
		} finally { cleanup(); }
	});
}

test("a stale caller joins the replacement request without overwriting it", async () => {
	await setup();
	try {
		const resolvers = [];
		globalThis.folderFetch = () => new Promise(resolve => { resolvers.push(resolve); });
		const staleCaller = client.getMailboxFolders("mb1");
		window.dispatchEvent(new window.Event("mailflare:messages-changed"));
		const freshCaller = client.getMailboxFolders("mb1");
		assert.equal(resolvers.length, 2);
		resolvers[0](response([{ id: "stale" }]));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(resolvers.length, 2);
		resolvers[1](response([{ id: "fresh" }]));
		assert.deepEqual((await staleCaller).folders, [{ id: "fresh" }]);
		assert.deepEqual((await freshCaller).folders, [{ id: "fresh" }]);
		assert.deepEqual((await client.getMailboxFolders("mb1")).folders, [{ id: "fresh" }]);
	} finally { cleanup(); }
});

test("session event rejects an old request even when its token has not changed yet", async () => {
	await setup();
	try {
		let resolveOld;
		globalThis.folderFetch = () => new Promise(resolve => { resolveOld = resolve; });
		const old = client.getMailboxFolders("mb1");
		window.dispatchEvent(new window.Event("auth-changed"));
		resolveOld(response([{ id: "old" }]));
		await assert.rejects(old, /invalidated/);
	} finally { cleanup(); }
});

test("continuous invalidation has a bounded retry count", async () => {
	await setup();
	try {
		let calls = 0;
		globalThis.folderFetch = async () => ({
			ok: true,
			json: async () => {
				calls++;
				window.dispatchEvent(new window.Event("mailflare:messages-changed"));
				return { folders: [{ id: String(calls) }] };
			},
		});
		await assert.rejects(client.getMailboxFolders("mb1"), /invalidated/);
		assert.equal(calls, 9);
	} finally { cleanup(); }
});

test("failed responses are not cached and explicit mutation invalidation clears cache", async () => {
	await setup();
	try {
		let calls = 0;
		globalThis.folderFetch = async () => { calls++; return calls === 1 ? { ok: false, json: async () => ({ error: "failed" }) } : response(); };
		await assert.rejects(client.getMailboxFolders("mb1"), /failed/);
		await client.getMailboxFolders("mb1");
		assert.equal(calls, 2);
		client.invalidateFolderCache();
		await client.getMailboxFolders("mb1");
		assert.equal(calls, 3);
	} finally { cleanup(); }
});

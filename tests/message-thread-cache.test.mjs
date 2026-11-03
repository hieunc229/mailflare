import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "thread-cache-test-"));
const target = join(temporary, "cache.mjs");
await build({
	entryPoints: [join(project, "src/components/messages/message-thread-cache.ts")], outfile: target,
	bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
	plugins: [{ name: "test-auth", setup(builder) {
		builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
			contents: "export const AUTH_SESSION_CHANGED_EVENT='session-changed';export function authFetch(...args){return globalThis.threadFetch(...args)}", loader: "js",
		}));
	} }],
});
const cache = await import(pathToFileURL(target).href);
const message = (id, read = false) => ({ id, read, textBody: `body ${id}`, htmlBody: null });
const response = (value, ok = true) => ({ ok, json: async () => value });
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.threadFetch; });

test("concurrent callers for the same message share one request and a cached reopen needs none", async () => {
	cache.clearMessageThreadCache(); let resolve; let requests = 0;
	globalThis.threadFetch = () => {
		requests++;
		return new Promise(done => { resolve = done; });
	};
	const first = cache.fetchMessageThread("one");
	const second = cache.fetchMessageThread("one");
	assert.equal(requests, 1);
	resolve(response({ messages: [message("one")] }));
	assert.deepEqual(await first, [message("one")]);
	assert.deepEqual(await second, [message("one")]);
	assert.deepEqual(await cache.fetchMessageThread("one"), [message("one")]);
	assert.equal(requests, 1);
});

test("different anchors do not share a cached conversation", async () => {
	cache.clearMessageThreadCache(); let requests = 0;
	globalThis.threadFetch = async (url) => {
		requests++;
		const id = String(url).split("/").at(-2);
		return response({ messages: [message(id)] });
	};
	assert.deepEqual(await cache.fetchMessageThread("one"), [message("one")]);
	assert.deepEqual(await cache.fetchMessageThread("two"), [message("two")]);
	assert.equal(requests, 2);
});

test("read flips patch cached conversations", async () => {
	cache.clearMessageThreadCache();
	globalThis.threadFetch = async () => response({ messages: [message("one"), message("two")] });
	await cache.fetchMessageThread("one");
	cache.markMessageThreadReadInCaches(["one"], true);
	assert.deepEqual(cache.getCachedMessageThread("one").map((item) => item.read), [true, false]);
});

test("invalidating the cache rejects stale responses and lets a fresh request win", async () => {
	cache.clearMessageThreadCache(); let resolveOld, resolveNew; let requests = 0;
	globalThis.threadFetch = () => new Promise(done => { requests++; resolveOld = done; });
	const old = cache.fetchMessageThread("one");
	const rejected = assert.rejects(old, /invalidated/);
	cache.clearMessageThreadCache();
	globalThis.threadFetch = () => new Promise(done => { requests++; resolveNew = done; });
	const fresh = cache.fetchMessageThread("one");
	resolveOld(response({ messages: [message("old")] }));
	await rejected;
	assert.equal(cache.getCachedMessageThread("one"), undefined);
	resolveNew(response({ messages: [message("new")] }));
	assert.deepEqual(await fresh, [message("new")]);
	assert.deepEqual(cache.getCachedMessageThread("one"), [message("new")]);
	assert.equal(requests, 2);
});

test("threads expire after a minute and very large conversations are not cached", async () => {
	cache.clearMessageThreadCache(); const now = Date.now; let time = 1000;
	Date.now = () => time;
	try {
		globalThis.threadFetch = async () => response({ messages: [message("one")] });
		await cache.fetchMessageThread("one");
		assert.ok(cache.getCachedMessageThread("one"));
		time += 60_001;
		assert.equal(cache.getCachedMessageThread("one"), undefined);

		const large = Array.from({ length: 51 }, (_, index) => message(String(index)));
		globalThis.threadFetch = async () => response({ messages: large });
		await cache.fetchMessageThread("large");
		assert.equal(cache.getCachedMessageThread("large"), undefined);
	} finally { Date.now = now; }
});

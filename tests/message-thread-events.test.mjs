import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "thread-events-test-"));
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
// The cache registers its event listeners at import time when a window exists.
globalThis.window = new EventTarget();
const cache = await import(pathToFileURL(target).href);
const message = (id) => ({ id, read: false, textBody: `body ${id}`, htmlBody: null });
const response = (value) => ({ ok: true, json: async () => value });
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.threadFetch; delete globalThis.window; });
const emit = (detail) => window.dispatchEvent(new CustomEvent("mailflare:messages-changed", { detail }));
async function cacheOne() {
	cache.clearMessageThreadCache();
	globalThis.threadFetch = async () => response({ messages: [message("one")] });
	await cache.fetchMessageThread("one");
	assert.ok(cache.getCachedMessageThread("one"));
}

test("a sync event keeps cached threads", async () => {
	await cacheOne();
	emit({ sync: true, realtime: true });
	assert.ok(cache.getCachedMessageThread("one"));
});

test("a sync event drops only the open thread's cached copy", async () => {
	await cacheOne();
	globalThis.threadFetch = async () => response({ messages: [message("two")] });
	await cache.fetchMessageThread("two");
	cache.dropThreadOnSync("one", new CustomEvent("x", { detail: { sync: true } }));
	assert.equal(cache.getCachedMessageThread("one"), undefined);
	assert.ok(cache.getCachedMessageThread("two"));
	await cache.fetchMessageThread("one");
	cache.dropThreadOnSync("one", new CustomEvent("x", { detail: { kind: "removed" } }));
	assert.ok(cache.getCachedMessageThread("one"), "only a sync event drops it");
});

test("a plain realtime event drops cached threads", async () => {
	await cacheOne();
	emit({ realtime: true });
	assert.equal(cache.getCachedMessageThread("one"), undefined);
});

test("threadNeedsRefetch skips read and patch events only", () => {
	const event = (detail) => new CustomEvent("x", { detail });
	assert.equal(cache.threadNeedsRefetch(event({ kind: "read" })), false);
	assert.equal(cache.threadNeedsRefetch(event({ kind: "patch" })), false);
	for (const detail of [undefined, { realtime: true }, { sync: true }, { kind: "removed" }]) assert.equal(cache.threadNeedsRefetch(event(detail)), true);
});

test("a 100-message conversation is cached and a 501-message one is not", async () => {
	cache.clearMessageThreadCache();
	globalThis.threadFetch = async () => response({ messages: Array.from({ length: 100 }, (_, index) => message(String(index))) });
	await cache.fetchMessageThread("hundred");
	assert.ok(cache.getCachedMessageThread("hundred"));
	globalThis.threadFetch = async () => response({ messages: Array.from({ length: 501 }, (_, index) => message(String(index))) });
	await cache.fetchMessageThread("huge");
	assert.equal(cache.getCachedMessageThread("huge"), undefined);
});

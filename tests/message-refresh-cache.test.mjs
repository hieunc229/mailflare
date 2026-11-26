import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-message-refresh-cache-"));
after(() => rmSync(temp, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export {
				registerMessageRefresh,
				refreshMessageViews,
			} from "./src/hooks/message-refresh.ts";
			export {
				fetchMessageCounts,
				fetchMessageList,
				peekMessageList,
			} from "./src/hooks/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "message-refresh-cache-entry.ts",
		loader: "ts",
	},
	outfile: join(temp, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "message-refresh-cache-stubs",
		setup(b) {
			b.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth-client", namespace: "test-stub" }));
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, () => ({
				contents: `
					export const AUTH_SESSION_CHANGED_EVENT = "mailflare:test-auth";
					export function authFetch(...args) { return globalThis.__testAuthFetch(...args); }
					export function getClientSessionToken() { return null; }
					export function setClientSessionToken() {}
					export function clearClientSessionToken() {}
					export function persistAuthSession() { return Promise.resolve({}); }
					export function getAuthHeaders(headers) { return new Headers(headers); }
				`,
				loader: "js",
			}));
		},
	}],
	logLevel: "silent",
});

const {
	fetchMessageCounts,
	fetchMessageList,
	peekMessageList,
	refreshMessageViews,
	registerMessageRefresh,
} = await import(pathToFileURL(join(temp, "entry.mjs")).href);

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((next, fail) => { resolve = next; reject = fail; });
	return { promise, resolve, reject };
}

function queueDeferredResponses() {
	const pending = [];
	globalThis.__testAuthFetch = (input) => {
		const request = deferred();
		pending.push({ url: String(input), ...request });
		return request.promise;
	};
	return pending;
}

test("refresh invalidates caches and runs every mounted task", async (t) => {
	const cleanups = [];
	t.after(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
	const params = new URLSearchParams("status=received&offset=25");
	let listRequests = 0;
	globalThis.__testAuthFetch = async () => {
		listRequests += 1;
		return jsonResponse({ messages: [{ id: "cached" }], total: 1 });
	};

	await fetchMessageList(params);
	assert.ok(peekMessageList(params), "the list starts cached");
	let firstRuns = 0;
	let secondRuns = 0;
	cleanups.push(registerMessageRefresh(async () => { firstRuns += 1; }));
	cleanups.push(registerMessageRefresh(async () => { secondRuns += 1; }));

	await refreshMessageViews();
	assert.equal(listRequests, 1, "refresh itself does not add another fetch pipeline");
	assert.equal(firstRuns, 1, "the first mounted view revalidates");
	assert.equal(secondRuns, 1, "the second mounted view revalidates too");
	assert.equal(peekMessageList(params), undefined, "the list cache was invalidated");
});

test("an older in-flight list response cannot overwrite the refreshed cache", async (t) => {
	const cleanups = [];
	t.after(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
	const pending = queueDeferredResponses();
	const params = new URLSearchParams("status=received&offset=25");

	const oldRequest = fetchMessageList(params, true);
	cleanups.push(registerMessageRefresh(() => fetchMessageList(params)));
	const refresh = refreshMessageViews();
	assert.equal(pending.length, 2);

	pending[1].resolve(jsonResponse({ messages: [{ id: "new" }], total: 1 }));
	await refresh;
	assert.deepEqual(peekMessageList(params)?.messages?.map((message) => message.id), ["new"]);

	pending[0].resolve(jsonResponse({ messages: [{ id: "old" }], total: 1 }));
	await oldRequest;
	assert.deepEqual(peekMessageList(params)?.messages?.map((message) => message.id), ["new"], "the stale response stays out of the cache");
});

test("an older in-flight counts response cannot overwrite the refreshed cache", async (t) => {
	const cleanups = [];
	t.after(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
	const pending = queueDeferredResponses();

	const oldRequest = fetchMessageCounts("mailbox-1", true);
	cleanups.push(registerMessageRefresh(() => fetchMessageCounts("mailbox-1")));
	cleanups.push(registerMessageRefresh(() => fetchMessageCounts("mailbox-1")));
	const refresh = refreshMessageViews();
	assert.equal(pending.length, 2, "both views share one refreshed counts request");

	const refreshedCounts = { folders: { inbox: { total: 7, unread: 3 } }, customFolders: {}, mailboxes: [] };
	pending[1].resolve(jsonResponse({ counts: refreshedCounts }));
	await refresh;
	pending[0].resolve(jsonResponse({ counts: { folders: { inbox: { total: 1, unread: 1 } }, customFolders: {}, mailboxes: [] } }));
	await oldRequest;

	let networkCalls = 0;
	globalThis.__testAuthFetch = async () => {
		networkCalls += 1;
		return jsonResponse({ counts: refreshedCounts });
	};
	const cached = await fetchMessageCounts("mailbox-1");
	assert.equal(cached?.folders.inbox.total, 7, "the stale counts response stays out of the cache");
	assert.equal(networkCalls, 0, "the refreshed counts are served from cache");
});

test("refresh reports a failure after all mounted tasks settle", async (t) => {
	const cleanups = [];
	t.after(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
	let completed = false;
	cleanups.push(registerMessageRefresh(async () => { completed = true; }));
	cleanups.push(registerMessageRefresh(async () => { throw new Error("refresh exploded"); }));

	await assert.rejects(refreshMessageViews(), /refresh exploded/);
	assert.equal(completed, true, "one failure does not skip the other mounted views");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/sw.js"), "utf8");

function loadWorker({ networkFetch = async () => new Response("ok"), cached = new Map(), addAll, existing = [], inCache = false, preload } = {}) {
	const listeners = new Map();
	const calls = { addAll: [], add: [], put: [], match: [], network: [], deleted: [], opened: [], preload: 0 };
	const cache = {
		addAll: async (urls) => {
			calls.addAll.push(urls);
			if (addAll) await addAll(urls);
		},
		add: async (url) => {
			calls.add.push(url);
		},
		match: async () => (inCache ? new Response("x") : undefined),
		put: async (request) => {
			calls.put.push(request);
		},
	};
	const caches = {
		open: async (name) => {
			calls.opened.push(name);
			return cache;
		},
		keys: async () => existing,
		delete: async (name) => {
			calls.deleted.push(name);
			return true;
		},
		match: async (request) => {
			const key = typeof request === "string" ? request : request.url;
			calls.match.push(key);
			return cached.get(key);
		},
	};
	const fetch = async (request) => {
		calls.network.push(request);
		return networkFetch(request);
	};
	const self = {
		addEventListener: (type, listener) => listeners.set(type, listener),
		skipWaiting: () => {},
		clients: { claim: async () => {} },
		registration: preload ? { navigationPreload: { enable: async () => calls.preload++ } } : {},
		location: { origin: "https://mail.example.com" },
	};
	vm.runInNewContext(source, { self, caches, fetch, console: { log() {}, warn() {} }, URL, Promise, Response });
	return { listeners, calls };
}

function extendable(event) {
	let pending;
	event.waitUntil = (promise) => {
		pending = promise;
	};
	return () => pending;
}

test("install precaches only the offline page", async () => {
	const { listeners, calls } = loadWorker();
	const event = {};
	const pending = extendable(event);
	listeners.get("install")(event);
	await pending();
	assert.deepEqual(JSON.parse(JSON.stringify(calls.addAll)), [["/offline.html"]]);
});

test("a failed precache does not fail the install", async () => {
	const { listeners, calls } = loadWorker({
		addAll: async () => {
			throw new TypeError("Request failed");
		},
	});
	const event = {};
	const pending = extendable(event);
	listeners.get("install")(event);
	await assert.doesNotReject(pending());
	assert.equal(calls.addAll.length, 1);
});

test("non-navigation requests are not intercepted", () => {
	const { listeners } = loadWorker();
	const event = {
		request: { url: "https://mail.example.com/api/messages", mode: "cors", method: "GET" },
		respondWith() {
			assert.fail("respondWith must not be called");
		},
	};
	listeners.get("fetch")(event);
});

test("a navigation that reaches the network is answered by the network", async () => {
	const network = new Response("<html>inbox</html>", { status: 200 });
	const { listeners, calls } = loadWorker({ networkFetch: async () => network });
	const request = { url: "https://mail.example.com/inbox", mode: "navigate", method: "GET" };
	let responded;
	listeners.get("fetch")({ request, respondWith: (value) => (responded = value) });
	assert.equal(await responded, network);
	assert.equal(calls.network[0], request);
	assert.deepEqual(calls.match, []);
});

test("a navigation that fails on the network gets the cached offline page", async () => {
	const offline = new Response("<html>offline</html>");
	const { listeners, calls } = loadWorker({
		networkFetch: async () => {
			throw new TypeError("Failed to fetch");
		},
		cached: new Map([["/offline.html", offline]]),
	});
	const request = { url: "https://mail.example.com/inbox", mode: "navigate", method: "GET" };
	let responded;
	listeners.get("fetch")({ request, respondWith: (value) => (responded = value) });
	const served = await responded;
	assert.equal(await served.text(), "<html>offline</html>");
	assert.deepEqual(calls.match, ["/offline.html"]);
});

test("a redirected cached offline page is served as a clean 200 response", async () => {
	const redirected = new Response("<html>offline</html>", { headers: { "content-type": "text/html" } });
	Object.defineProperty(redirected, "redirected", { value: true });
	const { listeners } = loadWorker({
		networkFetch: async () => {
			throw new TypeError("Failed to fetch");
		},
		cached: new Map([["/offline.html", redirected]]),
	});
	const request = { url: "https://mail.example.com/inbox", mode: "navigate", method: "GET" };
	let responded;
	listeners.get("fetch")({ request, respondWith: (value) => (responded = value) });
	const served = await responded;
	assert.equal(served.redirected, false);
	assert.equal(served.status, 200);
	assert.equal(served.headers.get("content-type"), "text/html");
	assert.equal(await served.text(), "<html>offline</html>");
});

test("a navigation uses the preloaded response instead of fetching again", async () => {
	const preloaded = new Response("preloaded");
	const { listeners, calls } = loadWorker();
	const request = { url: "https://mail.example.com/inbox", mode: "navigate", method: "GET" };
	let responded;
	listeners.get("fetch")({ request, preloadResponse: Promise.resolve(preloaded), respondWith: (value) => (responded = value) });
	assert.equal(await responded, preloaded);
	assert.equal(calls.network.length, 0);
});

test("a navigation falls back to fetch when there is no preloaded response", async () => {
	const network = new Response("net");
	const { listeners, calls } = loadWorker({ networkFetch: async () => network });
	const request = { url: "https://mail.example.com/inbox", mode: "navigate", method: "GET" };
	let responded;
	listeners.get("fetch")({ request, preloadResponse: Promise.resolve(undefined), respondWith: (value) => (responded = value) });
	assert.equal(await responded, network);
	assert.equal(calls.network.length, 1);
});

test("activate enables navigation preload when supported", async () => {
	const { listeners, calls } = loadWorker({ preload: true, inCache: true });
	const event = {};
	const pending = extendable(event);
	listeners.get("activate")(event);
	await pending();
	assert.equal(calls.preload, 1);
});

test("activate works without navigation preload support", async () => {
	const { listeners } = loadWorker({ inCache: true });
	const event = {};
	const pending = extendable(event);
	listeners.get("activate")(event);
	await assert.doesNotReject(pending());
});

test("activate deletes only older offline caches of this app", async () => {
	const { listeners, calls } = loadWorker({ existing: ["mailflare-offline-v1", "mailflare-offline-v2", "other-cache", "mailflare-offline-v0"], inCache: true });
	const event = {};
	const pending = extendable(event);
	listeners.get("activate")(event);
	await pending();
	assert.deepEqual(calls.deleted.sort(), ["mailflare-offline-v0", "mailflare-offline-v1"]);
});

test("activate re-adds the offline page when the cache lacks it, without blocking", async () => {
	const { listeners, calls } = loadWorker({ inCache: false });
	const event = {};
	const pending = extendable(event);
	listeners.get("activate")(event);
	await pending();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls.add, ["/offline.html"]);
});

test("activate does not re-add the offline page when it is cached", async () => {
	const { listeners, calls } = loadWorker({ inCache: true });
	const event = {};
	const pending = extendable(event);
	listeners.get("activate")(event);
	await pending();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls.add, []);
});

test("the fetch handler never writes responses into the cache", async () => {
	const { listeners, calls } = loadWorker();
	const request = { url: "https://mail.example.com/settings", mode: "navigate", method: "GET" };
	let responded;
	listeners.get("fetch")({ request, respondWith: (value) => (responded = value) });
	await responded;
	assert.equal(calls.put.length, 0);
});

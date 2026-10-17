import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/sw.js"), "utf8");

function countsResponse(unread) {
	return new Response(JSON.stringify({ counts: { folders: { inbox: { total: 10, unread } } } }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function push({ fetchImpl, visible = false }) {
	const listeners = new Map();
	const calls = { fetch: [], notifications: [], badge: [] };
	const self = {
		addEventListener: (type, listener) => listeners.set(type, listener),
		location: { origin: "https://mail.example.com" },
		clients: { matchAll: async () => [{ visibilityState: visible ? "visible" : "hidden" }] },
		registration: {
			showNotification: async (title, options) => {
				calls.notifications.push({ title, options });
			},
		},
		navigator: {
			setAppBadge: async (count) => {
				calls.badge.push(["set", count]);
			},
			clearAppBadge: async () => {
				calls.badge.push(["clear"]);
			},
		},
	};
	const fetch = async (url, init) => {
		calls.fetch.push({ url, init });
		return fetchImpl();
	};
	vm.runInNewContext(source, { self, fetch, URL, Promise });

	let pending;
	listeners.get("push")({
		data: { json: () => ({ title: "Ada", body: "Lunch?" }) },
		waitUntil: (promise) => {
			pending = promise;
		},
	});
	await pending;
	return calls;
}

test("a hidden push sets the badge to the all-mailbox inbox unread count", async () => {
	const calls = await push({ fetchImpl: () => countsResponse(7) });
	assert.deepEqual(calls.badge, [["set", 7]]);
	assert.equal(calls.fetch.length, 1);
	assert.equal(calls.fetch[0].url, "/api/messages/counts");
	assert.equal(calls.fetch[0].init.credentials, "include");
	assert.equal(calls.notifications.length, 1);
	assert.equal(calls.notifications[0].title, "Ada");
});

test("a zero unread count clears the badge", async () => {
	const calls = await push({ fetchImpl: () => countsResponse(0) });
	assert.deepEqual(calls.badge, [["clear"]]);
	assert.equal(calls.notifications.length, 1);
});

test("an unauthorized counts response leaves the badge untouched", async () => {
	const calls = await push({ fetchImpl: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) });
	assert.equal(calls.fetch.length, 1);
	assert.deepEqual(calls.badge, []);
	assert.equal(calls.notifications.length, 1);
});

test("a failed counts fetch leaves the badge untouched", async () => {
	const calls = await push({
		fetchImpl: () => {
			throw new TypeError("Failed to fetch");
		},
	});
	assert.equal(calls.fetch.length, 1);
	assert.deepEqual(calls.badge, []);
	assert.equal(calls.notifications.length, 1);
});

test("a visible window skips the notification, the fetch and the badge", async () => {
	const calls = await push({ fetchImpl: () => countsResponse(3), visible: true });
	assert.deepEqual(calls.fetch, []);
	assert.deepEqual(calls.badge, []);
	assert.deepEqual(calls.notifications, []);
});

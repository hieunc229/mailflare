import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-membership-overlay-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "https://mail.example/inbox",
	pretendToBeVisual: true,
});
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement", "CustomEvent"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
Object.defineProperty(globalThis.document, "visibilityState", { configurable: true, get: () => "visible" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const mock = new Map([
	["@/lib/auth/client", `
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";
export function authFetch(...args) { return globalThis.__testAuthFetch(...args); }
`],
	["@/lib/search/query-utils", `
export function parseSearchQuery() { return {}; }
`],
	["@/lib/time/utils", `
export function getUserTimeZone() { return "UTC"; }
`],
	["@/lib/messages/detail-cache", `
export function patchCachedMessage() {}
export function patchCachedMessageState() {}
export function invalidateCachedMessageDetails() {}
export function invalidateMessageDetailRequests() {}
`],
	["@/components/messages/message-thread-cache", `
export function clearMessageThreadCache() {}
export function invalidateMessageThreadRequests() {}
`],
]);

await build({
	stdin: {
		contents: `
			import React from "react";
			import { useMessages } from "./src/hooks/use-messages.ts";
			import {
				clearMessageClientState, fetchMessageList, peekMessageList,
			} from "./src/hooks/utils.ts";
			import { defaultMessageActionHooks } from "./src/lib/messages/actions/client.ts";
			import { MessageActionExecutor } from "./src/lib/messages/actions/executor.ts";
			import {
				clearMembershipForTests, hasMembershipOverlay,
			} from "./src/lib/messages/membership-store.ts";

			export {
				clearMessageClientState, fetchMessageList, peekMessageList,
				defaultMessageActionHooks, MessageActionExecutor,
				clearMembershipForTests, hasMembershipOverlay,
			};

			export function Harness({ folder = "inbox", folderId = null, offset = 0 }) {
				const list = useMessages(folder, "mailbox-1", { limit: 25, offset }, true, folderId);
				return React.createElement(
					"div",
					null,
					React.createElement("span", { "data-testid": "total" }, String(list.total)),
					React.createElement(
						"ul",
						null,
						list.messages.map((message) => React.createElement("li", {
							key: message.id,
							"data-id": message.id,
							"data-status": message.status,
							"data-members": JSON.stringify(message.threadMessageIds ?? null),
						})),
					),
				);
			}
		`,
		resolveDir: root,
		sourcefile: "membership-overlay-entry.tsx",
		loader: "tsx",
	},
	outfile: join(temp, "entry.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "membership-overlay-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => mock.has(args.path) ? { path: args.path, namespace: "test-stub" } : undefined);
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => ({ contents: mock.get(args.path), loader: "js", resolveDir: root }));
		},
	}],
	logLevel: "silent",
});

const { createElement, act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const m = await import(pathToFileURL(join(temp, "entry.mjs")).href);

function message(id, extra = {}) {
	return {
		id,
		userId: "user-1",
		mailboxId: "mailbox-1",
		folderId: null,
		direction: "inbound",
		providerMessageId: null,
		fromAddr: "sender@example.net",
		toAddr: "tester@example.com",
		ccAddr: null,
		bccAddr: null,
		fromContactName: "Sender",
		subject: `Subject ${id}`,
		snippet: "Preview",
		status: "received",
		read: false,
		starred: false,
		snoozedUntil: null,
		threadId: null,
		createdAt: "2026-10-01T10:00:00.000Z",
		...extra,
	};
}

function state(overrides = {}) {
	return {
		status: "received",
		read: false,
		starred: false,
		folderId: null,
		snoozedUntil: null,
		...overrides,
	};
}

function record(id, previous, applied) {
	return { id, mailboxId: "mailbox-1", previous: state(previous), applied: state(applied) };
}

const archived = (id) => record(id, {}, { status: "archived", folderId: null });

function applyResponse(action, applied, skipped = []) {
	return { ok: true, action, applied, skipped, undoToken: "token" };
}

function undoResponse(action, restored, skipped = []) {
	return { ok: true, action, restored, skipped: skipped.map((id) => ({ id, reason: "stale" })) };
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

let serverList = { messages: [], total: 0, limit: 25, offset: 0 };
globalThis.__testAuthFetch = (url) => {
	const target = String(url);
	if (!target.startsWith("/api/messages?")) {
		return Promise.resolve({ json: async () => ({}) });
	}
	return Promise.resolve({ json: async () => serverList });
};

const params = new URLSearchParams({
	timeZone: "UTC",
	direction: "inbound",
	status: "received",
	mailboxId: "mailbox-1",
	limit: "25",
	offset: "0",
});
const listParams = () => new URLSearchParams(params);

function ids(container) {
	return [...container.querySelectorAll("[data-id]")].map((element) => element.getAttribute("data-id"));
}

function total(container) {
	return container.querySelector('[data-testid="total"]').textContent;
}

function members(container, id) {
	return container.querySelector(`[data-id="${id}"]`)?.getAttribute("data-members");
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function render(strict = false, reset = true) {
	if (reset) {
		m.clearMessageClientState();
		m.clearMembershipForTests();
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	let disposed = false;
	const tree = createElement(m.Harness);
	await act(async () => {
		reactRoot.render(strict ? createElement(StrictMode, null, tree) : tree);
	});
	await flush();
	return {
		container,
		async cleanup() {
			if (disposed) return;
			disposed = true;
			await act(async () => reactRoot.unmount());
			container.remove();
		},
	};
}

function executorFor(transport) {
	return new m.MessageActionExecutor(transport, m.defaultMessageActionHooks);
}

test("a move is hidden optimistically and stays hidden through an in-flight list response", async (t) => {
	serverList = { messages: [message("m1"), message("m2")], total: 2, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);
	assert.deepEqual(ids(view.container), ["m1", "m2"]);

	const transport = deferred();
	const executor = executorFor(() => transport.promise);
	let running;
	await act(async () => {
		running = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});

	assert.deepEqual(ids(view.container), ["m2"]);
	assert.equal(total(view.container), "1");
	assert.equal(m.hasMembershipOverlay(), true);

	// The server still includes m1 while the action request is in flight.
	const during = await m.fetchMessageList(listParams(), true);
	assert.deepEqual(during.messages.map((item) => item.id), ["m2"]);
	assert.equal(during.total, 1);

	await act(async () => {
		transport.resolve(applyResponse("archive", [archived("m1")]));
		await running;
	});
	assert.equal(m.hasMembershipOverlay(), false);
	assert.deepEqual(ids(view.container), ["m2"]);
	assert.equal(total(view.container), "1");
});

test("a failed move restores the row immediately", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);
	const transport = deferred();
	const executor = executorFor(() => transport.promise);
	let running;
	await act(async () => {
		running = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), []);

	await act(async () => {
		transport.reject(new Error("network down"));
		await assert.rejects(running, /network down/);
	});
	assert.deepEqual(ids(view.container), ["m1"]);
	assert.equal(total(view.container), "1");
	assert.equal(m.hasMembershipOverlay(), false);
});

test("undo restores the row before the server answers and survives repeated ingress", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);

	const applyTransport = deferred();
	const undoTransport = deferred();
	const executor = executorFor((body) => body.op === "undo" ? undoTransport.promise : applyTransport.promise);
	let applying;
	await act(async () => {
		applying = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	await act(async () => {
		applyTransport.resolve(applyResponse("archive", [archived("m1")]));
		await applying;
	});
	assert.deepEqual(ids(view.container), []);

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	let undoing;
	await act(async () => {
		undoing = executor.undo([archived("m1")], "token");
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), ["m1"], "the tombstone paints immediately");
	assert.equal(total(view.container), "1");
	assert.equal(
		view.container.querySelector('[data-id="m1"]')?.getAttribute("data-status"),
		"received",
		"the restored row carries the previous membership, not the applied one",
	);
	assert.equal(m.hasMembershipOverlay(), true);

	const during = await m.fetchMessageList(listParams(), true);
	assert.deepEqual(during.messages.map((item) => item.id), ["m1"], "a refresh during undo cannot lose the row");
	assert.equal(during.total, 1);
	const repeated = await m.fetchMessageList(listParams(), true);
	assert.deepEqual(repeated.messages.map((item) => item.id), ["m1"], "ingress is replayable");

	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	await act(async () => {
		undoTransport.resolve(undoResponse("archive", ["m1"]));
		await undoing;
	});
	assert.deepEqual(ids(view.container), ["m1"]);
});

test("a remount during undo brings the row back from the tombstone", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const first = await render();
	t.after(first.cleanup);
	const applyTransport = deferred();
	const undoTransport = deferred();
	const executor = executorFor((body) => body.op === "undo" ? undoTransport.promise : applyTransport.promise);
	let applying;
	await act(async () => {
		applying = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	await act(async () => {
		applyTransport.resolve(applyResponse("archive", [archived("m1")]));
		await applying;
	});
	await first.cleanup();

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	let undoing;
	await act(async () => {
		undoing = executor.undo([archived("m1")], "token");
		await Promise.resolve();
	});

	const second = await render(false, false);
	t.after(second.cleanup);
	assert.deepEqual(ids(second.container), ["m1"], "the remount merges the restored tombstone");
	assert.equal(total(second.container), "1");

	await act(async () => {
		undoTransport.resolve(undoResponse("archive", ["m1"]));
		await undoing;
	});
});

test("a partial undo keeps restored rows and re-prunes the skipped ones", async (t) => {
	serverList = { messages: [message("m1"), message("m2")], total: 2, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);
	const applyTransport = deferred();
	const undoTransport = deferred();
	const executor = executorFor((body) => body.op === "undo" ? undoTransport.promise : applyTransport.promise);
	let applying;
	await act(async () => {
		applying = executor.run({ action: "archive", messageIds: ["m1", "m2"] });
		await Promise.resolve();
	});
	await act(async () => {
		applyTransport.resolve(applyResponse("archive", [archived("m1"), archived("m2")]));
		await applying;
	});
	assert.deepEqual(ids(view.container), []);

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	let undoing;
	await act(async () => {
		undoing = executor.undo([archived("m1"), archived("m2")], "token");
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), ["m1", "m2"]);

	await act(async () => {
		undoTransport.resolve(undoResponse("archive", ["m1"], ["m2"]));
		await undoing;
	});
	assert.deepEqual(ids(view.container), ["m1"], "only the restored row stays");
	assert.equal(total(view.container), "1");
});

test("StrictMode double mounting does not duplicate a restore or decrement the total twice", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const view = await render(true);
	t.after(view.cleanup);
	assert.deepEqual(ids(view.container), ["m1"]);
	assert.deepEqual(ids(view.container), ["m1"], "the double mount renders one row");

	const transport = deferred();
	const executor = executorFor(() => transport.promise);
	let running;
	await act(async () => {
		running = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), []);
	assert.equal(total(view.container), "0");
	await act(async () => {
		transport.resolve(applyResponse("archive", [archived("m1")]));
		await running;
	});
	assert.deepEqual(ids(view.container), []);
	assert.equal(total(view.container), "0");
});

test("sequential conversation removals keep every member for undo", async (t) => {
	serverList = {
		messages: [message("a", { threadId: "t1", threadMessageIds: ["a", "b"], threadCount: 2, threadUnread: 0 })],
		total: 1,
		limit: 25,
		offset: 0,
	};
	const view = await render();
	t.after(view.cleanup);

	const firstTransport = deferred();
	const firstExecutor = executorFor(() => firstTransport.promise);
	let first;
	await act(async () => {
		first = firstExecutor.run({ action: "archive", messageIds: ["a"] });
		await Promise.resolve();
	});
	await act(async () => {
		firstTransport.resolve(applyResponse("archive", [archived("a")]));
		await first;
	});
	assert.deepEqual(ids(view.container), ["a"]);
	assert.equal(members(view.container, "a"), JSON.stringify(["b"]));

	const secondTransport = deferred();
	const secondExecutor = executorFor(() => secondTransport.promise);
	let second;
	await act(async () => {
		second = secondExecutor.run({ action: "archive", messageIds: ["b"] });
		await Promise.resolve();
	});
	await act(async () => {
		secondTransport.resolve(applyResponse("archive", [archived("b")]));
		await second;
	});
	assert.deepEqual(ids(view.container), []);

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	const undoTransport = deferred();
	const undoExecutor = executorFor(() => undoTransport.promise);
	let undoing;
	await act(async () => {
		undoing = undoExecutor.undo([archived("a")], "token");
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), ["a"], "undoing the first removal still finds its member");
	assert.equal(members(view.container, "a"), JSON.stringify(["a"]));
	await act(async () => {
		undoTransport.resolve(undoResponse("archive", ["a"]));
		await undoing;
	});
});

test("a read/star undo settlement leaves a move tombstone intact", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);
	const applyTransport = deferred();
	const executor = executorFor(() => applyTransport.promise);
	let applying;
	await act(async () => {
		applying = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	await act(async () => {
		applyTransport.resolve(applyResponse("archive", [archived("m1")]));
		await applying;
	});
	assert.deepEqual(ids(view.container), []);

	// A star undo on the same id settles while the archive tombstone is live.
	const star = record("m1", {}, { starred: true });
	m.defaultMessageActionHooks.onUndoCompleted(
		[star],
		{ ok: true, action: "star", restored: ["m1"], skipped: [] },
		new Map(),
	);

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	const undoTransport = deferred();
	const undoExecutor = executorFor(() => undoTransport.promise);
	let undoing;
	await act(async () => {
		undoing = undoExecutor.undo([archived("m1")], "token");
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), ["m1"], "the archive tombstone survived the star settlement");
	await act(async () => {
		undoTransport.resolve(undoResponse("archive", ["m1"]));
		await undoing;
	});
});

test("a failed undo keeps its tombstone when the source list is unmounted", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);
	const applyTransport = deferred();
	const executor = executorFor(() => applyTransport.promise);
	let applying;
	await act(async () => {
		applying = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	await act(async () => {
		applyTransport.resolve(applyResponse("archive", [archived("m1")]));
		await applying;
	});
	await view.cleanup();

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	const failed = deferred();
	const failedExecutor = executorFor(() => failed.promise);
	let undoing;
	await act(async () => {
		undoing = failedExecutor.undo([archived("m1")], "token");
		await Promise.resolve();
	});
	await act(async () => {
		failed.reject(new Error("network down"));
		await assert.rejects(undoing, /network down/);
	});

	const second = await render(false, false);
	t.after(second.cleanup);
	assert.deepEqual(ids(second.container), [], "the failed undo does not reveal the moved row");

	const retry = deferred();
	const retryExecutor = executorFor(() => retry.promise);
	let retrying;
	await act(async () => {
		retrying = retryExecutor.undo([archived("m1")], "token");
		await Promise.resolve();
	});
	assert.deepEqual(ids(second.container), ["m1"], "the retry still had the tombstone");
	await act(async () => {
		retry.resolve(undoResponse("archive", ["m1"]));
		await retrying;
	});
});

test("a read/star skipped apply does not restore a move tombstone", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);
	const applyTransport = deferred();
	const executor = executorFor(() => applyTransport.promise);
	let applying;
	await act(async () => {
		applying = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	await act(async () => {
		applyTransport.resolve(applyResponse("archive", [archived("m1")]));
		await applying;
	});
	assert.deepEqual(ids(view.container), []);

	m.defaultMessageActionHooks.onApplied(
		{ ok: true, action: "read", applied: [], skipped: [{ id: "m1", reason: "failed" }] },
		{ notify: false },
	);
	assert.deepEqual(ids(view.container), [], "a read/star skip must not paint the moved row");

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	const undoTransport = deferred();
	const undoExecutor = executorFor(() => undoTransport.promise);
	let undoing;
	await act(async () => {
		undoing = undoExecutor.undo([archived("m1")], "token");
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), ["m1"], "the archive tombstone is still available");
	await act(async () => {
		undoTransport.resolve(undoResponse("archive", ["m1"]));
		await undoing;
	});
});

test("a failed read/star undo does not discard a move tombstone", async (t) => {
	serverList = { messages: [message("m1")], total: 1, limit: 25, offset: 0 };
	const view = await render();
	t.after(view.cleanup);
	const applyTransport = deferred();
	const executor = executorFor(() => applyTransport.promise);
	let applying;
	await act(async () => {
		applying = executor.run({ action: "archive", messageIds: ["m1"] });
		await Promise.resolve();
	});
	await act(async () => {
		applyTransport.resolve(applyResponse("archive", [archived("m1")]));
		await applying;
	});
	assert.deepEqual(ids(view.container), []);

	const star = record("m1", {}, { starred: true });
	m.defaultMessageActionHooks.onUndoFailed([star], new Map(), undefined, new Error("network down"));
	assert.deepEqual(ids(view.container), [], "the failed star undo keeps the row hidden");

	serverList = { messages: [], total: 0, limit: 25, offset: 0 };
	const undoTransport = deferred();
	const undoExecutor = executorFor(() => undoTransport.promise);
	let undoing;
	await act(async () => {
		undoing = undoExecutor.undo([archived("m1")], "token");
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), ["m1"], "the archive tombstone survived the failed star undo");
	await act(async () => {
		undoTransport.resolve(undoResponse("archive", ["m1"]));
		await undoing;
	});
});

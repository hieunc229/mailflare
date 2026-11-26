import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-list-removal-"));
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
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const mock = new Map([
	["@/lib/auth/client", `
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
`],
]);

await build({
	stdin: {
		contents: `
			import React from "react";
			import { useMessages } from "./src/hooks/use-messages.ts";
			import { clearMessageListCache } from "./src/hooks/utils.ts";
			import { clearKnownMessageFieldsForTests } from "./src/lib/messages/field-store.ts";

			export { clearMessageListCache, clearKnownMessageFieldsForTests };

			export function Harness({ folder = "inbox", folderId = null, offset = 0 }) {
				const list = useMessages(folder, "mailbox-1", { limit: 25, offset }, true, folderId);
				return React.createElement(
					"div",
					null,
					React.createElement("span", { "data-testid": "total" }, String(list.total)),
					React.createElement(
						"ul",
						null,
						list.messages.map((message) =>
							React.createElement("li", {
								key: message.id,
								"data-id": message.id,
								"data-subject": message.subject ?? "",
								"data-members": JSON.stringify(message.threadMessageIds ?? null),
							}, message.id),
						),
					),
				);
			}
		`,
		resolveDir: root,
		sourcefile: "list-removal-entry.tsx",
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
		name: "list-removal-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => mock.has(args.path) ? { path: args.path, namespace: "test-stub" } : undefined);
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => ({ contents: mock.get(args.path), loader: "js", resolveDir: root }));
		},
	}],
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Harness, clearMessageListCache, clearKnownMessageFieldsForTests } = await import(pathToFileURL(join(temp, "entry.mjs")).href);

let pending = [];
globalThis.__testAuthFetch = () => new Promise((resolve) => {
	pending.push(resolve);
});

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

function memberState(id, extra = {}) {
	return {
		id,
		status: "received",
		read: false,
		starred: false,
		folderId: null,
		snoozedUntil: null,
		...extra,
	};
}

function event(detail) {
	return new window.CustomEvent("mailflare:messages-changed", {
		detail: { kind: "removed", ...detail },
	});
}

function ids(container) {
	return [...container.querySelectorAll("[data-id]")].map((element) => element.getAttribute("data-id"));
}

function total(container) {
	return container.querySelector('[data-testid="total"]').textContent;
}

async function render({ folder = "inbox", folderId = null, offset = 0 } = {}) {
	clearMessageListCache();
	clearKnownMessageFieldsForTests();
	pending = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(createElement(Harness, { folder, folderId, offset }));
	});
	return {
		container,
		async cleanup() {
			await act(async () => reactRoot.unmount());
			container.remove();
		},
	};
}

async function resolveNext(data) {
	const resolve = pending.shift();
	assert.ok(resolve, "expected a pending message request");
	await act(async () => {
		resolve({ ok: true, status: 200, json: async () => data });
		await Promise.resolve();
	});
}

test("a successful move removes the row and total before the refetch starts", async (t) => {
	const view = await render();
	t.after(view.cleanup);
	await resolveNext({ messages: [message("m1"), message("m2"), message("m3")], total: 3, limit: 25, offset: 0 });
	assert.deepEqual(ids(view.container), ["m1", "m2", "m3"]);
	assert.equal(total(view.container), "3");

	await act(async () => {
		window.dispatchEvent(event({ action: "archive", messageIds: ["m2"] }));
	});

	assert.deepEqual(ids(view.container), ["m1", "m3"]);
	assert.equal(total(view.container), "2");
	assert.equal(pending.length, 0, "the debounced refetch has not started yet");
});

test("an in-flight refresh cannot put a removed row back", async (t) => {
	const view = await render();
	t.after(view.cleanup);
	const initial = { messages: [message("m1"), message("m2")], total: 2, limit: 25, offset: 0 };
	await resolveNext(initial);

	await act(async () => {
		window.dispatchEvent(new window.CustomEvent("mailflare:messages-changed"));
	});
	await new Promise((resolve) => setTimeout(resolve, 180));
	assert.equal(pending.length, 1, "the background refresh started");

	await act(async () => {
		window.dispatchEvent(event({ action: "archive", messageIds: ["m2"] }));
	});
	assert.deepEqual(ids(view.container), ["m1"]);

	await act(async () => {
		pending.shift()({ ok: true, status: 200, json: async () => initial });
		await Promise.resolve();
	});
	assert.deepEqual(ids(view.container), ["m1"], "the stale response was ignored");
	assert.equal(total(view.container), "1");

	await new Promise((resolve) => setTimeout(resolve, 180));
	assert.equal(pending.length, 1, "the replacement request started");
	await resolveNext({ messages: [message("m1")], total: 1, limit: 25, offset: 0 });
	assert.deepEqual(ids(view.container), ["m1"]);
});

test("a conversation row keeps its header until its last message is removed", async (t) => {
	const view = await render();
	t.after(view.cleanup);
	await resolveNext({
		messages: [
			message("m1", { threadId: "t1", threadMessageIds: ["m1", "m1b"], threadCount: 2, threadUnread: 0 }),
			message("m2"),
		],
		total: 2,
		limit: 25,
		offset: 0,
	});

	await act(async () => {
		window.dispatchEvent(event({ action: "archive", messageIds: ["m1"] }));
	});
	assert.deepEqual(ids(view.container), ["m1", "m2"]);
	assert.equal(
		view.container.querySelector('[data-id="m1"]')?.getAttribute("data-subject"),
		"Subject m1",
		"the row keeps the header that belongs to its id",
	);
	assert.equal(total(view.container), "2");

	await act(async () => {
		window.dispatchEvent(event({ action: "archive", messageIds: ["m1b"] }));
	});
	assert.deepEqual(ids(view.container), ["m2"]);
	assert.equal(total(view.container), "1");
});

test("a repeated removal event decrements the total once", async (t) => {
	const view = await render();
	t.after(view.cleanup);
	await resolveNext({ messages: [message("m1"), message("m2")], total: 2, limit: 25, offset: 0 });

	const removal = event({ action: "archive", messageIds: ["m2"] });
	await act(async () => {
		window.dispatchEvent(removal);
		window.dispatchEvent(removal);
	});

	assert.deepEqual(ids(view.container), ["m1"]);
	assert.equal(total(view.container), "1");
});

test("a read change never removes a row", async (t) => {
	const view = await render();
	t.after(view.cleanup);
	await resolveNext({ messages: [message("m1")], total: 1, limit: 25, offset: 0 });

	await act(async () => {
		window.dispatchEvent(new window.CustomEvent("mailflare:messages-changed", {
			detail: { kind: "read", messageIds: ["m1"], read: true },
		}));
	});

	assert.deepEqual(ids(view.container), ["m1"]);
	assert.equal(total(view.container), "1");
});

test("Starred keeps a moved row but drops a permanently deleted one", async (t) => {
	const view = await render({ folder: "starred" });
	t.after(view.cleanup);
	await resolveNext({ messages: [message("m1", { starred: true })], total: 1, limit: 25, offset: 0 });

	await act(async () => {
		window.dispatchEvent(event({ action: "archive", messageIds: ["m1"] }));
	});
	assert.deepEqual(ids(view.container), ["m1"]);
	assert.equal(total(view.container), "1");

	await act(async () => {
		window.dispatchEvent(event({ action: "delete", messageIds: ["m1"] }));
	});
	assert.deepEqual(ids(view.container), []);
	assert.equal(total(view.container), "0");
});

test("a custom folder keeps snoozed rows and loses assigned ones", async (t) => {
	const view = await render({ folder: "inbox", folderId: "f1" });
	t.after(view.cleanup);
	await resolveNext({ messages: [message("m1", { folderId: "f1" })], total: 1, limit: 25, offset: 0 });

	await act(async () => {
		window.dispatchEvent(event({ action: "snooze", messageIds: ["m1"], snoozedUntil: "2030-01-01T10:00:00.000Z" }));
	});
	assert.deepEqual(ids(view.container), ["m1"]);

	await act(async () => {
		window.dispatchEvent(event({ action: "archive", messageIds: ["m1"] }));
	});
	assert.deepEqual(ids(view.container), []);
});

test("a custom folder keeps a row on a same-folder move and drops a real one", async (t) => {
	const view = await render({ folder: "inbox", folderId: "f1" });
	t.after(view.cleanup);
	await resolveNext({ messages: [message("m1", { folderId: "f1" })], total: 1, limit: 25, offset: 0 });

	await act(async () => {
		window.dispatchEvent(event({ action: "folder", messageIds: ["m1"], folderId: "f1" }));
	});
	assert.deepEqual(ids(view.container), ["m1"]);

	await act(async () => {
		window.dispatchEvent(event({ action: "folder", messageIds: ["m1"], folderId: "f2" }));
	});
	assert.deepEqual(ids(view.container), []);
});

test("Snoozed keeps a resnoozed row and drops an unsnoozed one", async (t) => {
	const view = await render({ folder: "snoozed" });
	t.after(view.cleanup);
	await resolveNext({
		messages: [message("m1", { snoozedUntil: "2030-01-01T10:00:00.000Z" })],
		total: 1,
		limit: 25,
		offset: 0,
	});

	await act(async () => {
		window.dispatchEvent(event({ action: "snooze", messageIds: ["m1"], snoozedUntil: "2030-01-02T10:00:00.000Z" }));
	});
	assert.deepEqual(ids(view.container), ["m1"]);

	await act(async () => {
		window.dispatchEvent(event({ action: "unsnooze", messageIds: ["m1"] }));
	});
	assert.deepEqual(ids(view.container), []);
});

test("committed states remove only the members the server applied", async (t) => {
	const view = await render();
	t.after(view.cleanup);
	await resolveNext({
		messages: [message("m1", { threadId: "t1", threadMessageIds: ["m1", "m2"], threadCount: 2, threadUnread: 0 })],
		total: 1,
		limit: 25,
		offset: 0,
	});

	await act(async () => {
		window.dispatchEvent(event({
			action: "spam",
			messageIds: ["m1"],
			states: [memberState("m1", { status: "spam" })],
		}));
	});

	assert.deepEqual(ids(view.container), ["m1"], "the conversation still has an eligible member");
	assert.equal(
		view.container.querySelector('[data-id="m1"]')?.getAttribute("data-members"),
		JSON.stringify(["m2"]),
	);
	assert.equal(total(view.container), "1");
});

test("an optimistic grouped direction-dependent move waits for committed state", async (t) => {
	const view = await render({ folder: "archived" });
	t.after(view.cleanup);
	await resolveNext({
		messages: [message("m1", { status: "archived", threadId: "t1", threadMessageIds: ["m1", "m2"], threadCount: 2, threadUnread: 0 })],
		total: 1,
		limit: 25,
		offset: 0,
	});

	await act(async () => {
		window.dispatchEvent(event({ action: "spam", messageIds: ["m1", "m2"], localOnly: true }));
	});
	assert.deepEqual(ids(view.container), ["m1"], "the representative's direction cannot decide for every member");
	assert.equal(
		view.container.querySelector('[data-id="m1"]')?.getAttribute("data-members"),
		JSON.stringify(["m1", "m2"]),
	);

	await act(async () => {
		window.dispatchEvent(event({
			action: "spam",
			messageIds: ["m1"],
			states: [memberState("m1", { status: "spam" })],
		}));
	});
	assert.deepEqual(ids(view.container), ["m1"]);
	assert.equal(
		view.container.querySelector('[data-id="m1"]')?.getAttribute("data-members"),
		JSON.stringify(["m2"]),
	);
});

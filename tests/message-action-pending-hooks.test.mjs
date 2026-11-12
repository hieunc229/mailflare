import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act } from "react";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-action-pending-hooks-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "https://mail.example/inbox",
	pretendToBeVisual: true,
});
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { createRoot } from "react-dom/client";
			import { act } from "react";
			import { useMessages } from "@/hooks/use-messages";
			import { useMessageCounts } from "@/hooks/use-message-counts";
			import { defaultMessageActionHooks } from "@/lib/messages/actions/client";
			import {
				fetchMessageList, clearMessageListCache, clearMessageCountsCache,
				peekMessageList, fetchMessageCounts,
			} from "@/hooks/utils";
			import {
				captureMessageFields, captureThreadUnread, clearKnownMessageFieldsForTests, hasPendingOverlay,
			} from "@/lib/messages/field-store";
			import { primeMessageDetail } from "@/lib/messages/detail-cache";
			export { act, primeMessageDetail };
			export { defaultMessageActionHooks } from "@/lib/messages/actions/client";
			export { captureMessageFields, captureThreadUnread, hasPendingOverlay, clearKnownMessageFieldsForTests };
			export async function seed(params, messages, counts) {
				clearMessageListCache();
				clearMessageCountsCache();
				clearKnownMessageFieldsForTests();
				await fetchMessageList(params, true);
				await fetchMessageCounts(null, true);
				return { list: peekMessageList(params), counts };
			}
			function Probe() {
				const { messages } = useMessages("inbox", null, { limit: 25, offset: 0, group: "thread" });
				const { counts } = useMessageCounts(null);
				const row = messages[0];
				return createElement("div", {
					"data-read": row ? String(row.read) : "missing",
					"data-thread-unread": row ? String(row.threadUnread) : "missing",
					"data-inbox-unread": String(counts.folders.inbox.unread),
				});
			}
			export async function mount() {
				document.body.replaceChildren();
				const container = document.createElement("div");
				document.body.appendChild(container);
				const root = createRoot(container);
				await act(async () => {
					root.render(createElement(Probe));
				});
				return {
					container,
					async unmount() { await act(async () => root.unmount()); },
				};
			}
			export async function settle(ms = 250) {
				await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
			}
		`,
		resolveDir: root,
		loader: "tsx",
	},
	outfile: join(directory, "hooks.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	tsconfig: join(root, "tsconfig.json"),
	external: ["react", "react-dom", "react-dom/client", "jsdom"],
	alias: { "@": join(root, "src") },
	logLevel: "silent",
	loader: { ".js": "jsx" },
	plugins: [
		{
			name: "runtime-stubs",
			setup(builder) {
				builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
			},
		},
	],
});
const m = await import(pathToFileURL(join(directory, "hooks.mjs")).href);

const originalFetch = globalThis.fetch;
const state = (overrides = {}) => ({
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});
const record = (id, previous, applied) => ({
	id,
	mailboxId: "mb1",
	previous: state(previous),
	applied: state(applied),
});
const emptyCounts = (inboxUnread) => ({
	folders: {
		inbox: { total: 1, unread: inboxUnread },
		starred: { total: 0, unread: 0 },
		snoozed: { total: 0, unread: 0 },
		sent: { total: 0, unread: 0 },
		scheduled: { total: 0, unread: 0 },
		drafts: { total: 0, unread: 0 },
		archived: { total: 0, unread: 0 },
		spam: { total: 0, unread: 0 },
		trash: { total: 0, unread: 0 },
	},
	customFolders: {},
	mailboxes: [],
});

test("mounted list and counts consumers keep the optimistic undo through refresh and reconcile after settle", async () => {
	const params = new URLSearchParams({
		timeZone: "UTC",
		direction: "inbound",
		status: "received",
		limit: "25",
		offset: "0",
		group: "thread",
	});
	let listCalls = 0;
	let countCalls = 0;
	let serverRead = true;
	let serverThreadUnread = 0;
	let serverInboxUnread = 0;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes("/api/messages/counts")) {
			countCalls += 1;
			return Response.json({ counts: emptyCounts(serverInboxUnread) });
		}
		listCalls += 1;
		return Response.json({
			messages: [{
				id: "m1",
				read: serverRead,
				starred: false,
				threadMessageIds: ["m1", "m2"],
				threadUnread: serverThreadUnread,
			}],
			total: 1,
			limit: 25,
			offset: 0,
		});
	};
	await m.seed(params, [], emptyCounts(0));
	const app = await m.mount();
	const read = () => app.container.querySelector("div").dataset;
	assert.equal(read().read, "true");
	assert.equal(read().threadUnread, "0");
	assert.equal(read().inboxUnread, "0");

	m.primeMessageDetail({ id: "m1", read: true, starred: false, threadId: null });
	const undo = record("m1", { read: false }, { read: true });
	const captured = m.captureMessageFields(["m1"]);
	const capturedThreads = m.captureThreadUnread(["m1"]);
	assert.equal(captured.get("m1").read, true);
	assert.equal(capturedThreads.get("m1"), 0);
	await act(async () => {
		m.defaultMessageActionHooks.onUndoOptimistic([undo], captured);
	});
	assert.equal(read().read, "false");
	assert.equal(read().threadUnread, "1");
	assert.equal(m.hasPendingOverlay(), true);

	// The server still has the pre-undo state. A generic realtime refresh while
	// the undo request is unresolved must be overlaid.
	serverRead = true;
	serverThreadUnread = 0;
	serverInboxUnread = 0;
	const listCallsBefore = listCalls;
	const countCallsBefore = countCalls;
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent("mailflare:messages-changed", { detail: { realtime: true } }));
	});
	await m.settle();
	assert.equal(listCalls, listCallsBefore + 1, "the list still performs the generic refresh");
	assert.equal(read().read, "false", "the held undo stays visible");
	assert.equal(read().threadUnread, "1");
	assert.equal(countCalls, countCallsBefore, "counts wait for the pending undo to settle");
	assert.equal(read().inboxUnread, "0");

	// Once the undo settles, one authoritative fetch reconciles counts and list.
	serverRead = false;
	serverThreadUnread = 1;
	serverInboxUnread = 1;
	await act(async () => {
		m.defaultMessageActionHooks.onUndoCompleted([undo], {
			ok: true,
			action: "read",
			restored: ["m1"],
			skipped: [],
		}, captured);
		m.defaultMessageActionHooks.onResync();
	});
	assert.equal(m.hasPendingOverlay(), false);
	await m.settle();
	assert.equal(read().read, "false");
	assert.equal(read().threadUnread, "1");
	assert.equal(read().inboxUnread, "1");
	assert.ok(countCalls > countCallsBefore, "counts refetch after settle");
	await app.unmount();
});

after(() => {
	globalThis.fetch = originalFetch;
	dom.window.close();
});

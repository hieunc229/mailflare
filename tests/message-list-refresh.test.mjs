import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-message-refresh-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "https://mail.example/inbox",
	pretendToBeVisual: true,
});
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement", "CustomEvent"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const mocks = new Map([
	["next/link", `
import React from "react";
export default function Link({ href, children, ...props }) {
  return React.createElement("a", { href, ...props }, children);
}
`],
	["@/components/language-provider", `
export function useLanguage() {
  return { t(key, vars) { return vars && vars.total !== undefined ? key + ":" + vars.total : key; } };
}
`],
	["@/components/mail-search/mail-search-context", `
export function useMailSearch() {
  return { query: globalThis.__testQuery ?? "", input: "", setQuery() {} };
}
`],
	["@/components/mailbox-provider", `
export function useSelectedMailbox() {
  return globalThis.__testMailboxState;
}
`],
	["@/components/page-loading", `
export function usePageLoading() {}
`],
	["@/components/sidebar-mobile-utils", `
export function useIsMobile() { return false; }
export function useIsDesktop() { return true; }
`],
	["@/components/messages/use-conversation-view", `
export function useConversationView() { return [false, () => {}]; }
`],
	["@/components/follow-ups/due-follow-ups", `
export function DueFollowUps() { return null; }
`],
	["@/lib/auth/client", `
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:test-auth";
export function authFetch(...args) { return globalThis.__testAuthFetch(...args); }
export function getClientSessionToken() { return null; }
export function setClientSessionToken() {}
export function clearClientSessionToken() {}
export function persistAuthSession() { return Promise.resolve({}); }
export function getAuthHeaders(headers) { return new Headers(headers); }
`],
]);

const relativeStub = `
import React from "react";
export function MessageListRowActions() { return null; }
export function SwipeableRow({ children }) { return children; }
export function useMessageNavigation() {
  return { onNavigate() {}, prefetch() {}, prefetchNow() {}, cancelPrefetch() {} };
}
`;

await build({
	stdin: {
		contents: `
			import React from "react";
			import { MessageFolderPage } from "./src/components/messages/message-folder-page.tsx";
			import { inboxFolderConfig } from "./src/components/messages/message-folder-configs.ts";
			import { clearMessageListCache, clearMessageCountsCache } from "./src/hooks/utils.ts";

			export function Harness({ compact }) {
				return React.createElement(MessageFolderPage, { config: inboxFolderConfig, compact });
			}
			export { clearMessageListCache, clearMessageCountsCache };
		`,
		resolveDir: root,
		sourcefile: "message-refresh-entry.tsx",
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
		name: "message-refresh-test-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => {
				if (mocks.has(args.path)) return { path: args.path, namespace: "test-stub" };
				if (["./message-navigation", "./message-list-row-actions", "./swipeable-row"].includes(args.path)) {
					return { path: "relative-stub", namespace: "test-relative-stub" };
				}
				return undefined;
			});
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => ({ contents: mocks.get(args.path), loader: "tsx", resolveDir: root }));
			b.onLoad({ filter: /.*/, namespace: "test-relative-stub" }, () => ({ contents: relativeStub, loader: "tsx", resolveDir: root }));
		},
	}],
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Harness, clearMessageListCache, clearMessageCountsCache } = await import(pathToFileURL(join(temp, "entry.mjs")).href);

function message(index) {
	return {
		id: `m${index}`,
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
		subject: `Subject ${index}`,
		snippet: "Preview",
		status: "received",
		read: false,
		starred: false,
		threadId: null,
		createdAt: "2026-10-01T10:00:00.000Z",
	};
}

function countsBody(inboxTotal = 30, unread = 30) {
	return {
		counts: {
			folders: {
				inbox: { total: inboxTotal, unread },
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
		},
	};
}

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

function waitForAsyncWork() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function installFetchStub({ list, counts }) {
	const calls = [];
	let listIndex = 0;
	let countsIndex = 0;
	globalThis.__testAuthFetch = (input) => {
		const url = String(input);
		calls.push(url);
		if (url.startsWith("/api/messages/counts")) {
			return Promise.resolve(counts[Math.min(countsIndex++, counts.length - 1)]());
		}
		return Promise.resolve(list[Math.min(listIndex++, list.length - 1)]());
	};
	return calls;
}

async function renderPage(compact = false) {
	clearMessageListCache();
	clearMessageCountsCache();
	globalThis.__testQuery = "invoice";
	globalThis.__testMailboxState = {
		selectedMailbox: {
			id: "mailbox-1",
			localPart: "tester",
			hostname: "example.com",
			displayName: "Tester",
			senderAddresses: ["tester@example.com"],
		},
		isLoading: false,
		mailboxes: [],
	};
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(createElement(Harness, { compact }));
		await waitForAsyncWork();
	});
	return {
		container,
		async cleanup() {
			await act(async () => reactRoot.unmount());
			container.remove();
		},
	};
}

test("refresh keeps the current filters and page, and preserves the selection", async (t) => {
	const firstPage = Array.from({ length: 25 }, (_, index) => message(index + 1));
	const secondPage = Array.from({ length: 5 }, (_, index) => message(index + 26));
	const calls = installFetchStub({
		list: [
			() => jsonResponse({ messages: firstPage, total: 30, limit: 25, offset: 0 }),
			() => jsonResponse({ messages: secondPage, total: 30, limit: 25, offset: 25 }),
		],
		counts: [() => jsonResponse(countsBody())],
	});
	const { container, cleanup } = await renderPage(true);
	t.after(cleanup);

	await act(async () => {
		container.querySelector('button[aria-label="list.nextPage"]').click();
		await waitForAsyncWork();
	});
	const listCallsBeforeRefresh = calls.filter((url) => url.startsWith("/api/messages?"));
	const countsCallsBeforeRefresh = calls.filter((url) => url.startsWith("/api/messages/counts"));
	const pageUrl = listCallsBeforeRefresh.at(-1);
	assert.match(pageUrl, /[?&]offset=25(?:&|$)/);
	assert.match(pageUrl, /[?&]q=invoice(?:&|$)/);
	assert.match(pageUrl, /[?&]mailboxId=mailbox-1(?:&|$)/);

	const rowCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
	await act(async () => rowCheckbox.click());
	assert.equal(container.querySelectorAll('input[type="checkbox"]:checked').length, 1, "the row is selected before refreshing");

	const listRefresh = deferred();
	const countsRefresh = deferred();
	globalThis.__testAuthFetch = (input) => {
		const url = String(input);
		calls.push(url);
		return url.startsWith("/api/messages/counts") ? countsRefresh.promise : listRefresh.promise;
	};
	await act(async () => {
		container.querySelector('button[aria-label="list.refresh"]').click();
		await waitForAsyncWork();
	});

	const pendingButton = container.querySelector('button[aria-label="list.refreshing"]');
	assert.ok(pendingButton, "the refresh control reports its pending state");
	assert.equal(pendingButton.getAttribute("aria-busy"), "true");
	assert.equal(pendingButton.disabled, true);
	assert.match(pendingButton.querySelector("svg").getAttribute("class"), /animate-spin/);

	const refreshListUrl = calls.filter((url) => url.startsWith("/api/messages?"))[listCallsBeforeRefresh.length];
	const refreshCountsUrl = calls.filter((url) => url.startsWith("/api/messages/counts"))[countsCallsBeforeRefresh.length];
	assert.equal(refreshListUrl, pageUrl, "refresh revalidates the same page and filters");
	assert.equal(refreshCountsUrl, countsCallsBeforeRefresh.at(-1), "refresh revalidates the same mailbox counts");

	const refreshedResponse = jsonResponse({
		messages: secondPage.map((item, index) => index === 0 ? { ...item, subject: "Refreshed subject" } : item),
		total: 30,
		limit: 25,
		offset: 25,
	});
	await act(async () => {
		listRefresh.resolve(refreshedResponse);
		countsRefresh.resolve(jsonResponse(countsBody()));
		await waitForAsyncWork();
	});

	assert.ok(container.querySelector('button[aria-label="list.refresh"]'), "the control returns to its idle label");
	assert.match(container.textContent, /Refreshed subject/);
	assert.equal(container.querySelectorAll('input[type="checkbox"]:checked').length, 1, "refresh keeps the selected row");
	assert.equal(container.querySelector('[role="alert"]'), null, "a successful refresh shows no error");
});

test("a stale first load cannot replace the refreshed rows", async (t) => {
	const initialLoad = deferred();
	const refreshedLoad = deferred();
	let listRequests = 0;
	globalThis.__testAuthFetch = (input) => {
		const url = String(input);
		if (url.startsWith("/api/messages/counts")) return Promise.resolve(jsonResponse(countsBody(2, 2)));
		listRequests += 1;
		return listRequests === 1 ? initialLoad.promise : refreshedLoad.promise;
	};
	const { container, cleanup } = await renderPage();
	t.after(cleanup);

	await act(async () => {
		container.querySelector('button[aria-label="list.refresh"]').click();
		await waitForAsyncWork();
	});
	assert.equal(listRequests, 2, "refresh starts a new list request while the first is still in flight");

	await act(async () => {
		refreshedLoad.resolve(jsonResponse({ messages: [message(2)], total: 1, limit: 25, offset: 0 }));
		await waitForAsyncWork();
	});
	assert.match(container.textContent, /Subject 2/);

	await act(async () => {
		initialLoad.resolve(jsonResponse({ messages: [message(1)], total: 1, limit: 25, offset: 0 }));
		await waitForAsyncWork();
	});
	assert.match(container.textContent, /Subject 2/, "the refreshed rows stay visible");
	assert.doesNotMatch(container.textContent, /Subject 1/, "the older in-flight response is ignored");
});

test("refresh failure is announced and leaves the list in place", async (t) => {
	const messages = Array.from({ length: 2 }, (_, index) => message(index + 1));
	const calls = installFetchStub({
		list: [() => jsonResponse({ messages, total: 2, limit: 25, offset: 0 })],
		counts: [() => jsonResponse(countsBody(2, 2))],
	});
	const { container, cleanup } = await renderPage();
	t.after(cleanup);

	const listRefresh = deferred();
	const countsRefresh = deferred();
	globalThis.__testAuthFetch = (input) => {
		const url = String(input);
		calls.push(url);
		return url.startsWith("/api/messages/counts") ? countsRefresh.promise : listRefresh.promise;
	};
	await act(async () => {
		container.querySelector('button[aria-label="list.refresh"]').click();
		await waitForAsyncWork();
	});

	await act(async () => {
		countsRefresh.resolve(jsonResponse(countsBody(2, 2)));
		listRefresh.resolve(jsonResponse({ error: "boom" }, 500));
		await waitForAsyncWork();
	});

	const alert = container.querySelector('[role="alert"]');
	assert.ok(alert, "a failed refresh is announced");
	assert.match(alert.textContent, /list\.refreshFailed/);
	assert.match(container.textContent, /Subject 1/, "the previous list stays visible after a failed refresh");
	assert.ok(container.querySelector('button[aria-label="list.refresh"]'), "the control is usable again after a failure");
});

test("refresh is present in the compact split-list toolbar", async (t) => {
	const messages = [message(1)];
	installFetchStub({
		list: [() => jsonResponse({ messages, total: 1, limit: 25, offset: 0 })],
		counts: [() => jsonResponse(countsBody(1, 1))],
	});
	const { container, cleanup } = await renderPage(true);
	t.after(cleanup);
	assert.ok(container.querySelector('button[aria-label="list.refresh"]'), "the compact list has a refresh control");
});

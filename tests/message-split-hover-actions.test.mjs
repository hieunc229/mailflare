import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-message-hover-actions-"));
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
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;

const languageStub = `
export function useLanguage() {
  return { t(key) { return key; } };
}
`;

const uiStub = `
import React from "react";
export const Button = React.forwardRef(function Button({ children, variant, size, className, ...props }, ref) {
  return React.createElement("button", { ref, className, ...props }, children);
});
export function Tooltip({ children }) { return children; }
export function Dialog({ open, children }) {
  return open ? React.createElement("div", { "data-testid": "snooze-dialog" }, children) : null;
}
export function DialogContent({ children }) { return React.createElement("div", null, children); }
export function DialogHeader({ children }) { return React.createElement("div", null, children); }
export function DialogDescription({ children }) { return React.createElement("div", null, children); }
export function DialogTitle({ children }) { return React.createElement("h2", null, children); }
export function Input(props) { return React.createElement("input", props); }
export function Checkbox({ className, ...props }) { return React.createElement("input", { type: "checkbox", className, ...props }); }
export async function confirmDestructive() { return false; }
export async function alertDialog() {}
`;

const iconStub = `
import React from "react";
function Icon(props) { return React.createElement("span", { "aria-hidden": "true", ...props }); }
export const Archive = Icon;
export const CalendarClock = Icon;
export const ChevronLeft = Icon;
export const ChevronRight = Icon;
export const Clock = Icon;
export const Folder = Icon;
export const ListFilter = Icon;
export const Mail = Icon;
export const MailOpen = Icon;
export const MailCheck = Icon;
export const MoreVertical = Icon;
export const Send = Icon;
export const ShieldAlert = Icon;
export const Star = Icon;
export const Trash2 = Icon;
`;

const rowActionsUtilsStub = `
export function isMessageSnoozed(value) {
  return !!value && new Date(value) > new Date();
}
export function getSnoozePresets() {
  return [{ labelKey: "snooze.tomorrow", value: "2026-10-02T09:00" }];
}
export async function snoozeMessage(messageId, snoozedUntil) {
  globalThis.__snoozeCalls.push({ messageId, snoozedUntil });
}
export async function unsnoozeMessage(messageId) {
  globalThis.__unsnoozeCalls.push(messageId);
}
`;

const actionMenuStub = `
import React from "react";
export function MessageActionMenu({ label, trigger, children }) {
  return React.createElement("div", { "data-testid": "action-menu", "data-label": label },
    trigger,
    React.createElement("div", { "data-testid": "action-menu-items" }, children),
  );
}
export function MessageActionMenuItem({ children, onSelect, disabled, destructive }) {
  return React.createElement("button", {
    type: "button",
    onClick: onSelect,
    disabled,
    "data-destructive": String(!!destructive),
  }, children);
}
export function MessageActionMenuSeparator() { return null; }
export function MessageActionMenuLabel({ children }) { return React.createElement("div", null, children); }
`;

await build({
	stdin: {
		contents: `
			export { MessageListRowActions } from "./src/components/messages/message-list-row-actions.tsx";
		`,
		resolveDir: root,
		sourcefile: "message-row-actions-entry.tsx",
		loader: "tsx",
	},
	outfile: join(temp, "row-actions.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "message-row-actions-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => {
				if (args.path.startsWith("@/components/ui/")) return { path: "ui", namespace: "test-stub" };
				if (args.path === "@/components/language-provider") return { path: "language", namespace: "test-stub" };
				if (args.path === "@/components/icons") return { path: "icons", namespace: "test-stub" };
				if (args.path === "@/components/message-actions/action-menu") return { path: "action-menu", namespace: "test-stub" };
				if (args.path === "@/lib/time/utils") return { path: "time", namespace: "test-stub" };
				if (args.path === "./message-list-row-actions-utils") return { path: "row-actions-utils", namespace: "test-stub" };
				if (args.path === "./unsubscribe-button") return { path: "unsubscribe", namespace: "test-stub" };
				return undefined;
			});
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => {
				if (args.path === "ui") return { contents: uiStub, loader: "tsx", resolveDir: root };
				if (args.path === "language") return { contents: languageStub, loader: "tsx", resolveDir: root };
				if (args.path === "icons") return { contents: iconStub, loader: "tsx", resolveDir: root };
				if (args.path === "action-menu") return { contents: actionMenuStub, loader: "tsx", resolveDir: root };
				if (args.path === "time") return { contents: `export function getUserTimeZone() { return "UTC"; }`, loader: "tsx", resolveDir: root };
				if (args.path === "row-actions-utils") return { contents: rowActionsUtilsStub, loader: "tsx", resolveDir: root };
				if (args.path === "unsubscribe") return {
					contents: `
						import React from "react";
						export function MessageUnsubscribeButton({ messageId, iconOnly }) {
							return React.createElement("button", {
								"aria-label": "actions.unsubscribe",
								"data-message-id": messageId,
								"data-icon-only": String(!!iconOnly),
							}, "unsubscribe");
						}
					`,
					loader: "tsx",
					resolveDir: root,
				};
				return undefined;
			});
		},
	}],
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MessageListRowActions } = await import(pathToFileURL(join(temp, "row-actions.mjs")).href);

function message(overrides = {}) {
	return {
		id: "m1",
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
		subject: "Subject",
		snippet: "Preview",
		status: "received",
		read: false,
		starred: false,
		threadId: null,
		createdAt: "2026-10-01T10:00:00.000Z",
		hasUnsubscribe: false,
		snoozedUntil: null,
		...overrides,
	};
}

async function renderActions(props) {
	const container = document.createElement("div");
	container.className = "group relative";
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(createElement(MessageListRowActions, props));
	});
	return {
		container,
		async rerender(nextProps) {
			await act(async () => {
				reactRoot.render(createElement(MessageListRowActions, nextProps));
			});
		},
		async cleanup() {
			await act(async () => reactRoot.unmount());
			container.remove();
		},
	};
}

function button(container, label) {
	const match = container.querySelector(`button[aria-label="${label}"]`);
	assert.ok(match, `expected a ${label} action`);
	return match;
}

function menuItem(container, label) {
	const items = [...container.querySelectorAll('[data-testid="action-menu-items"] button')];
	const match = items.find((item) => item.textContent.includes(label));
	assert.ok(match, `expected a ${label} overflow action`);
	return match;
}

test("the compact rail keeps a small primary set and reaches the rest from overflow", async (t) => {
	const actions = [];
	const { container, rerender, cleanup } = await renderActions({
		message: message({ hasUnsubscribe: true }),
		onAction: async (action) => { actions.push(action); },
		compact: true,
		active: true,
	});
	t.after(cleanup);

	const rail = container.querySelector("div.absolute");
	assert.ok(rail, "the action rail is absolute inside the row");
	assert.match(rail.className, /(^|\s)bg-blue-50(\s|$)/, "the active row uses the active-row surface");
	assert.match(rail.className, /(^|\s)h-8(\s|$)/, "the rail is content-sized instead of spanning the row");
	assert.match(rail.className, /(^|\s)rounded-full(\s|$)/);
	assert.match(rail.className, /has-\[\[data-state=open\]\]:opacity-100/, "the pill stays visible while the overflow menu is open");
	assert.doesNotMatch(rail.className, /(^|\s)inset-y-0(\s|$)/, "the rail has no full-height dead click area");
	assert.equal(container.querySelector('[aria-label="actions.unsubscribe"]')?.dataset.iconOnly, "true", "the unsubscribe action is icon-sized in the compact rail");

	assert.ok(button(container, "common.archive"), "archive stays a direct primary action");
	assert.ok(button(container, "common.moreActions"), "the overflow trigger is discoverable");
	assert.equal(container.querySelector('button[aria-label="common.trash"]'), null, "destructive trash is not under the row open area");
	assert.equal(container.querySelector('button[aria-label="common.markRead"]'), null, "read is in overflow");
	assert.equal(container.querySelector('button[aria-label="common.snooze"]'), null, "snooze is in overflow");
	assert.equal(menuItem(container, "common.trash").dataset.destructive, "true");

	await act(async () => button(container, "common.archive").click());
	await act(async () => menuItem(container, "common.markRead").click());
	await act(async () => menuItem(container, "common.trash").click());
	assert.deepEqual(actions, ["archive", "read", "trash"]);

	await rerender({
		message: message({ read: true }),
		onAction: async (action) => { actions.push(action); },
		compact: true,
		active: false,
	});
	assert.match(container.querySelector("div.absolute").className, /(^|\s)bg-neutral-50(\s|$)/, "a normal row uses the row surface");
	assert.ok(menuItem(container, "common.markUnread"), "the overflow action follows the current read state");
});

test("snoozing and unsnoozing notify the list only after the API succeeds", async (t) => {
	globalThis.__snoozeCalls = [];
	globalThis.__unsnoozeCalls = [];
	const changes = [];
	const props = {
		message: message(),
		onAction: async () => {},
		compact: true,
		onSnoozeChange: (messageId, snoozed) => changes.push([messageId, snoozed]),
	};
	const { container, rerender, cleanup } = await renderActions(props);
	t.after(cleanup);

	await act(async () => menuItem(container, "common.snooze").click());
	const dialog = container.querySelector('[data-testid="snooze-dialog"]');
	assert.ok(dialog, "the snooze dialog opens from the compact row");
	await act(async () => {
		[...dialog.querySelectorAll("button")].at(-1).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	assert.deepEqual(globalThis.__snoozeCalls, [{ messageId: "m1", snoozedUntil: "2026-10-02T09:00" }]);
	assert.deepEqual(changes, [["m1", true]], "a successful snooze tells the list the row may leave");

	await rerender({
		...props,
		message: message({ snoozedUntil: "2099-01-01T00:00:00.000Z" }),
	});
	await act(async () => {
		menuItem(container, "common.unsnooze").click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.deepEqual(globalThis.__unsnoozeCalls, ["m1"]);
	assert.deepEqual(changes, [["m1", true], ["m1", false]], "a successful unsnooze tells the list the row may leave");
});

const pageMocks = new Map([
	["next/navigation", `
import React from "react";
export function useRouter() {
  return { push(path) { globalThis.__pushedPaths.push(path); }, prefetch() {}, refresh() {} };
}
export function usePathname() { return "/inbox"; }
`],
	["next/link", `
import React from "react";
export default function Link({ href, children, ...props }) {
  return React.createElement("a", { href, ...props }, children);
}
`],
	["@/components/language-provider", languageStub],
	["@/components/mail-search/mail-search-context", `
export function useMailSearch() { return { query: "" }; }
`],
	["@/components/mailbox-provider", `
export function useSelectedMailbox() {
  return {
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
}
`],
	["@/components/page-loading", `export function usePageLoading() {}`],
	["@/components/sidebar-mobile-utils", `
export function useIsMobile() { return globalThis.__isMobile === true; }
export function useIsDesktop() { return globalThis.__isDesktop !== false; }
export function useHasHover() { return globalThis.__hasHover !== false; }
`],
	["@/hooks/use-message-counts", `
export function useMessageCounts() {
  return {
    counts: {
      folders: { inbox: { total: 2, unread: 2 }, snoozed: { total: 1, unread: 0 }, starred: { total: 1, unread: 1 } },
      customFolders: {},
      mailboxes: [],
    },
  };
}
`],
	["@/hooks/use-messages", `
export function useMessages() {
  return {
    messages: globalThis.__testMessages,
    isLoading: false,
    total: globalThis.__testMessages.length,
    limit: 25,
    updateMessages() {},
  };
}
`],
	["@/components/follow-ups/due-follow-ups", `export function DueFollowUps() { return null; }`],
	["@/components/messages/use-conversation-view", `export function useConversationView() { return [globalThis.__grouped === true, () => {}]; }`],
	["@/components/messages/message-open-status", `
export function OpenedIndicator() { return null; }
`],
	["@/components/messages/message-notes-popover", `
export function MessageNotesPopover() { return null; }
export function NoteBadge() { return null; }
`],
	["@/components/messages/bulk-message-toolbar", `export function BulkMessageToolbar() { return null; }`],
	["@/components/messages/message-list-refresh-button", `export function MessageListRefreshButton() { return null; }`],
	["@/components/messages/message-list-row-actions", `
import React from "react";
export function MessageListRowActions({ message, onAction, onSnoozeChange, compact, active }) {
  globalThis.__rowSnoozeCallbacks[message.id] = onSnoozeChange;
  return React.createElement("div", {
    "data-testid": "row-actions",
    "data-message-id": message.id,
    "data-compact": String(!!compact),
    "data-active": String(!!active),
  },
    React.createElement("button", { "aria-label": "stub-archive", onClick: () => { void onAction("archive"); } }),
    React.createElement("button", { "aria-label": "stub-read", onClick: () => { void onAction("read"); } }),
    React.createElement("button", { "aria-label": "stub-snooze", onClick: () => onSnoozeChange?.(message.id, true) }),
    React.createElement("button", { "aria-label": "stub-unsnooze", onClick: () => onSnoozeChange?.(message.id, false) }),
  );
}
`],
	["@/components/messages/message-navigation", `
export function useMessageNavigation() {
  return { onNavigate() {}, prefetch() {}, prefetchNow() {}, cancelPrefetch() {} };
}
`],
	["@/components/messages/message-detail-navigation-utils", `export function rememberOpenedUnreadMessage() {}`],
	["@/components/messages/swipeable-row", `
export function SwipeableRow({ children }) { return children; }
`],
]);

const relativeMocks = new Map([
	["./bulk-message-toolbar", "@/components/messages/bulk-message-toolbar"],
	["./message-detail-navigation-utils", "@/components/messages/message-detail-navigation-utils"],
	["./message-list-refresh-button", "@/components/messages/message-list-refresh-button"],
	["./message-list-row-actions", "@/components/messages/message-list-row-actions"],
	["./message-navigation", "@/components/messages/message-navigation"],
	["./message-notes-popover", "@/components/messages/message-notes-popover"],
	["./message-open-status", "@/components/messages/message-open-status"],
	["./swipeable-row", "@/components/messages/swipeable-row"],
	["./use-conversation-view", "@/components/messages/use-conversation-view"],
]);

await build({
	stdin: {
		contents: `
			import React from "react";
			import { MessageFolderPage } from "./src/components/messages/message-folder-page.tsx";
			import { inboxFolderConfig, snoozedFolderConfig, starredFolderConfig } from "./src/components/messages/message-folder-configs.ts";
			export { MessageFolderPage, inboxFolderConfig, snoozedFolderConfig, starredFolderConfig };
		`,
		resolveDir: root,
		sourcefile: "message-folder-hover-actions-entry.tsx",
		loader: "tsx",
	},
	outfile: join(temp, "folder-page.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "message-folder-hover-actions-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => {
				const mockPath = pageMocks.has(args.path) ? args.path : relativeMocks.get(args.path);
				if (mockPath) return { path: mockPath, namespace: "test-stub" };
				if (args.path.startsWith("@/components/ui/")) return { path: "ui", namespace: "test-stub" };
				if (args.path === "@/components/icons") return { path: "icons", namespace: "test-stub" };
				return undefined;
			});
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => {
				if (args.path === "ui") return { contents: uiStub, loader: "tsx", resolveDir: root };
				if (args.path === "icons") return { contents: iconStub, loader: "tsx", resolveDir: root };
				return { contents: pageMocks.get(args.path), loader: "tsx", resolveDir: root };
			});
		},
	}],
	logLevel: "silent",
});

const { MessageFolderPage, inboxFolderConfig, snoozedFolderConfig, starredFolderConfig } = await import(pathToFileURL(join(temp, "folder-page.mjs")).href);

function listMessage(id, overrides = {}) {
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
		threadId: null,
		createdAt: "2026-10-01T10:00:00.000Z",
		...overrides,
	};
}

function setCurrentRoute(config, selectedMessageId) {
	const path = selectedMessageId ? `${config.hrefPrefix}/${selectedMessageId}` : config.hrefPrefix;
	window.history.replaceState({}, "", path);
}

function jsonResponse(body) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * The action client moved from /api/messages/bulk to /api/messages/actions in
 * the undo branch. Answer both shapes so this harness stays branch-independent.
 */
function actionApiResponse(input, init) {
	let body = {};
	try {
		body = JSON.parse(String(init?.body ?? "{}"));
	} catch {
		body = {};
	}
	const url = typeof input === "string" ? input : input.url;
	if (url.includes("/api/messages/actions")) {
		if (body.op === "undo") return jsonResponse({ ok: true, action: body.action ?? "archive", restored: [], skipped: [] });
		return jsonResponse({ ok: true, action: body.action ?? "archive", applied: [], skipped: [] });
	}
	return jsonResponse({ ok: true });
}

async function renderFolderPage({ config = inboxFolderConfig, selectedMessageId, messages, desktop = true, mobile = false, hover = true, grouped = false } = {}) {
	globalThis.__isDesktop = desktop;
	globalThis.__isMobile = mobile;
	globalThis.__hasHover = hover;
	globalThis.__grouped = grouped;
	globalThis.__testMessages = messages ?? [listMessage("m1"), listMessage("m2")];
	globalThis.__pushedPaths = [];
	globalThis.__rowSnoozeCallbacks = {};
	globalThis.__deferredAction = null;
	globalThis.fetch = async (input, init) => {
		if (globalThis.__deferredAction) await globalThis.__deferredAction.promise;
		return actionApiResponse(input, init);
	};

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	setCurrentRoute(config, selectedMessageId);
	await act(async () => {
		reactRoot.render(createElement(MessageFolderPage, {
			config,
			compact: true,
			selectedMessageId,
		}));
	});
	return {
		container,
		async rerender(nextSelectedMessageId) {
			setCurrentRoute(config, nextSelectedMessageId);
			await act(async () => {
				reactRoot.render(createElement(MessageFolderPage, {
					config,
					compact: true,
					selectedMessageId: nextSelectedMessageId,
				}));
			});
		},
		async cleanup() {
			await act(async () => reactRoot.unmount());
			container.remove();
		},
	};
}

function deferredAction() {
	let resolve;
	const promise = new Promise((next) => { resolve = next; });
	return { promise, resolve };
}

function rowActions(container, messageId) {
	return container.querySelector(`[data-testid="row-actions"][data-message-id="${messageId}"]`);
}

test("the compact list exposes actions only beside an open desktop reader", async (t) => {
	const open = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(open.cleanup);
	const activeActions = rowActions(open.container, "m1");
	assert.ok(activeActions, "the open row keeps its hover actions in the split list");
	assert.equal(activeActions.dataset.compact, "true");
	assert.equal(activeActions.dataset.active, "true");
	assert.ok(rowActions(open.container, "m2"), "every eligible row can be acted on from the list");
	assert.match(
		rowActions(open.container, "m2").parentElement.className,
		/focus-within:bg-neutral-50/,
		"keyboard focus uses the same row surface as the rail",
	);

	const hidden = await renderFolderPage({ selectedMessageId: "m1", desktop: false });
	t.after(hidden.cleanup);
	assert.equal(rowActions(hidden.container, "m1"), null, "the hidden tablet list does not add desktop hover actions");

	const coarse = await renderFolderPage({ selectedMessageId: "m1", hover: false });
	t.after(coarse.cleanup);
	assert.equal(rowActions(coarse.container, "m1"), null, "wide touch screens get no invisible hover-only rail");

	const mobile = await renderFolderPage({ selectedMessageId: "m1", desktop: false, mobile: true });
	t.after(mobile.cleanup);
	assert.equal(rowActions(mobile.container, "m1"), null, "mobile keeps its swipe-only rows");

	const starred = await renderFolderPage({ config: starredFolderConfig, selectedMessageId: "m1" });
	t.after(starred.cleanup);
	assert.equal(rowActions(starred.container, "m1"), null, "folder eligibility stays unchanged");

	const outbound = await renderFolderPage({
		selectedMessageId: "m1",
		messages: [listMessage("m1", { direction: "outbound" })],
	});
	t.after(outbound.cleanup);
	assert.equal(rowActions(outbound.container, "m1"), null, "direction eligibility stays unchanged");
});

test("removing the open message from the folder returns to its list", async (t) => {
	const archive = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(archive.cleanup);
	await act(async () => {
		archive.container.querySelector('[data-message-id="m1"] [aria-label="stub-archive"]').click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.deepEqual(globalThis.__pushedPaths, ["/inbox"]);

	const read = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(read.cleanup);
	await act(async () => {
		read.container.querySelector('[data-message-id="m1"] [aria-label="stub-read"]').click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.deepEqual(globalThis.__pushedPaths, [], "read and unread leave the reader open");
});

test("a pending removal for A does not close B after navigating away", async (t) => {
	const page = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(page.cleanup);
	const request = deferredAction();
	globalThis.__deferredAction = request;

	await act(async () => rowActions(page.container, "m1").querySelector('[aria-label="stub-archive"]').click());
	await page.rerender("m2");
	request.resolve();
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

	assert.deepEqual(globalThis.__pushedPaths, [], "the reader that is open when the request finishes stays open");
});

test("a pending removal does not navigate after switching folders", async (t) => {
	const page = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(page.cleanup);
	const request = deferredAction();
	globalThis.__deferredAction = request;

	await act(async () => rowActions(page.container, "m1").querySelector('[aria-label="stub-archive"]').click());
	window.history.replaceState({}, "", "/sent/m2");
	request.resolve();
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

	assert.deepEqual(globalThis.__pushedPaths, [], "an old folder's pending action cannot move the current route");
});

test("a pending removal for the current reader still returns to the list", async (t) => {
	const page = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(page.cleanup);
	const request = deferredAction();
	globalThis.__deferredAction = request;

	await act(async () => rowActions(page.container, "m1").querySelector('[aria-label="stub-archive"]').click());
	request.resolve();
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

	assert.deepEqual(globalThis.__pushedPaths, ["/inbox"]);
});

test("delayed snooze callbacks check the reader that is open when they resolve", async (t) => {
	const inbox = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(inbox.cleanup);
	const staleInboxSnooze = globalThis.__rowSnoozeCallbacks.m1;
	await inbox.rerender("m2");
	await act(async () => staleInboxSnooze("m1", true));
	assert.deepEqual(globalThis.__pushedPaths, [], "a snooze for the previous reader leaves the current reader open");

	await inbox.rerender("m1");
	const currentInboxSnooze = globalThis.__rowSnoozeCallbacks.m1;
	await act(async () => currentInboxSnooze("m1", true));
	assert.deepEqual(globalThis.__pushedPaths, ["/inbox"], "a snooze for the current reader still closes it");

	const snoozed = await renderFolderPage({
		config: snoozedFolderConfig,
		selectedMessageId: "m1",
		messages: [listMessage("m1", { snoozedUntil: "2099-01-01T00:00:00.000Z" })],
	});
	t.after(snoozed.cleanup);
	const staleUnsnooze = globalThis.__rowSnoozeCallbacks.m1;
	await snoozed.rerender("m2");
	await act(async () => staleUnsnooze("m1", false));
	assert.deepEqual(globalThis.__pushedPaths, [], "an unsnooze for the previous reader leaves the current reader open");

	await snoozed.rerender("m1");
	const currentUnsnooze = globalThis.__rowSnoozeCallbacks.m1;
	await act(async () => currentUnsnooze("m1", false));
	assert.deepEqual(globalThis.__pushedPaths, ["/snoozed"], "an unsnooze for the current reader still closes it");
});

test("archiving a conversation row closes the reader when the open message is in its thread", async (t) => {
	const page = await renderFolderPage({
		selectedMessageId: "m1-thread",
		grouped: true,
		messages: [listMessage("m1", { threadMessageIds: ["m1", "m1-thread"], threadCount: 2 })],
	});
	t.after(page.cleanup);

	await act(async () => {
		rowActions(page.container, "m1").querySelector('[aria-label="stub-archive"]').click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.deepEqual(globalThis.__pushedPaths, ["/inbox"], "the whole row leaves the folder with the open thread member");
});

test("snooze changes close the reader only when the row leaves snoozed or inbox", async (t) => {
	const inbox = await renderFolderPage({ selectedMessageId: "m1" });
	t.after(inbox.cleanup);
	await act(async () => rowActions(inbox.container, "m1").querySelector('[aria-label="stub-snooze"]').click());
	assert.deepEqual(globalThis.__pushedPaths, ["/inbox"]);

	const snoozed = await renderFolderPage({
		config: snoozedFolderConfig,
		selectedMessageId: "m1",
		messages: [listMessage("m1", { snoozedUntil: "2099-01-01T00:00:00.000Z" })],
	});
	t.after(snoozed.cleanup);
	await act(async () => rowActions(snoozed.container, "m1").querySelector('[aria-label="stub-unsnooze"]').click());
	assert.deepEqual(globalThis.__pushedPaths, ["/snoozed"]);

	const custom = await renderFolderPage({
		config: { ...inboxFolderConfig, folderId: "folder-1", hrefPrefix: "/folders/folder-1" },
		selectedMessageId: "m1",
		messages: [listMessage("m1", { folderId: "folder-1" })],
	});
	t.after(custom.cleanup);
	await act(async () => rowActions(custom.container, "m1").querySelector('[aria-label="stub-snooze"]').click());
	assert.deepEqual(globalThis.__pushedPaths, [], "a custom folder keeps a snoozed row visible");
});

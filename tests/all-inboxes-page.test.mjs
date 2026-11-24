import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-all-inboxes-page-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "https://mail.example/all-inboxes",
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

const uiStub = `
import React from "react";
export const Button = React.forwardRef(function Button({ children, variant, size, className, ...props }, ref) {
  return React.createElement("button", { ref, className, ...props }, children);
});
export function Tooltip({ children }) { return children; }
export function Checkbox({ className, ...props }) { return React.createElement("input", { type: "checkbox", className, ...props }); }
export async function confirmDestructive() { return false; }
export async function alertDialog() {}
`;

const iconStub = `
import React from "react";
function Icon(props) { return React.createElement("span", { "aria-hidden": "true", ...props }); }
export const Archive = Icon;
export const ArchiveRestore = Icon;
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
export const ShieldCheck = Icon;
export const Star = Icon;
export const Trash2 = Icon;
export const Undo2 = Icon;
`;

const stubs = new Map([
	["next/navigation", `
export function useRouter() { return { push(path) { globalThis.__pushedPaths.push(path); }, prefetch() {}, refresh() {} }; }
export function usePathname() { return "/all-inboxes"; }
`],
	["next/link", `
import React from "react";
export default function Link({ href, children, ...props }) { return React.createElement("a", { href, ...props }, children); }
`],
	["@/components/language-provider", `export function useLanguage() { return { t(key) { return key; } }; }`],
	["@/components/mail-search/mail-search-context", `export function useMailSearch() { return { query: "" }; }`],
	["@/components/mailbox-provider", `
export function useSelectedMailbox() {
  return { selectedMailbox: globalThis.__mailboxes[0], mailboxes: globalThis.__mailboxes, isLoading: false };
}
`],
	["@/components/page-loading", `export function usePageLoading() {}`],
	["@/components/sidebar-mobile-utils", `
export function useIsMobile() { return false; }
export function useIsDesktop() { return true; }
export function useHasHover() { return true; }
`],
	["@/hooks/use-message-counts", `
export function useMessageCounts(mailboxId) {
  globalThis.__countScopes.push(mailboxId);
  return { counts: { folders: { inbox: { total: 2, unread: 2 } }, customFolders: {}, mailboxes: [] } };
}
`],
	["@/hooks/use-messages", `
export function useMessages(folder, mailboxId) {
  globalThis.__listScopes.push(mailboxId);
  return { messages: globalThis.__testMessages, isLoading: false, total: globalThis.__testMessages.length, limit: 25, updateMessages() {} };
}
`],
	["@/components/follow-ups/due-follow-ups", `export function DueFollowUps() { globalThis.__followUpsRendered = true; return null; }`],
	["@/components/messages/use-conversation-view", `export function useConversationView() { return [false, () => {}]; }`],
	["@/components/messages/message-open-status", `export function OpenedIndicator() { return null; }`],
	["@/components/messages/message-notes-popover", `
export function MessageNotesPopover() { return null; }
export function NoteBadge() { return null; }
`],
	["@/components/messages/bulk-message-toolbar", `export function BulkMessageToolbar(props) { globalThis.__toolbarProps = props; return null; }`],
	["@/components/messages/message-list-refresh-button", `export function MessageListRefreshButton() { return null; }`],
	["@/components/messages/message-list-row-actions", `
import React from "react";
export function MessageListRowActions({ message, onAction }) {
  return React.createElement("button", { "aria-label": "stub-read", "data-message-id": message.id, onClick: () => { void onAction("read"); } });
}
`],
	["@/components/messages/message-navigation", `
export function useMessageNavigation() { return { onNavigate() {}, prefetch() {}, prefetchNow() {}, cancelPrefetch() {} }; }
`],
	["@/components/messages/message-detail-navigation-utils", `export function rememberOpenedUnreadMessage() {}`],
	["@/components/messages/swipeable-row", `export function SwipeableRow({ children }) { return children; }`],
]);

const relativeStubs = new Map([
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
			export { MessageFolderPage } from "./src/components/messages/message-folder-page.tsx";
			export { BulkMessageActionBar } from "./src/components/messages/bulk-message-action-bar.tsx";
			export { inboxFolderConfig, allInboxesFolderConfig } from "./src/components/messages/message-folder-configs.ts";
		`,
		resolveDir: root,
		sourcefile: "all-inboxes-page-entry.tsx",
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
		name: "all-inboxes-page-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => {
				const stubPath = stubs.has(args.path) ? args.path : relativeStubs.get(args.path);
				if (stubPath) return { path: stubPath, namespace: "test-stub" };
				if (args.path.startsWith("@/components/ui/")) return { path: "ui", namespace: "test-stub" };
				if (args.path === "@/components/icons") return { path: "icons", namespace: "test-stub" };
				return undefined;
			});
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => {
				if (args.path === "ui") return { contents: uiStub, loader: "tsx", resolveDir: root };
				if (args.path === "icons") return { contents: iconStub, loader: "tsx", resolveDir: root };
				return { contents: stubs.get(args.path), loader: "tsx", resolveDir: root };
			});
		},
	}],
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MessageFolderPage, BulkMessageActionBar, inboxFolderConfig, allInboxesFolderConfig } = await import(pathToFileURL(join(temp, "folder-page.mjs")).href);

const support = { id: "support", localPart: "support", hostname: "example.com", displayName: "Support" };
const billing = { id: "billing", localPart: "billing", hostname: "example.com", displayName: null };

function listMessage(id, mailboxId) {
	return {
		id,
		userId: "user-1",
		mailboxId,
		folderId: null,
		direction: "inbound",
		providerMessageId: null,
		fromAddr: "sender@example.net",
		toAddr: `${mailboxId}@example.com`,
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
	};
}

function jsonResponse(body) {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function mount(element) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	await act(async () => reactRoot.render(element));
	return {
		container,
		async cleanup() {
			await act(async () => reactRoot.unmount());
			container.remove();
		},
	};
}

async function renderPage(config, { compact = true } = {}) {
	globalThis.__mailboxes = [support, billing];
	globalThis.__testMessages = [listMessage("s1", "support"), listMessage("b1", "billing")];
	globalThis.__listScopes = [];
	globalThis.__countScopes = [];
	globalThis.__followUpsRendered = false;
	globalThis.__toolbarProps = null;
	globalThis.__pushedPaths = [];
	globalThis.fetch = async () => jsonResponse({ ok: true, action: "read", applied: [], skipped: [] });
	window.history.replaceState({}, "", config.hrefPrefix);
	return mount(createElement(MessageFolderPage, { config, compact }));
}

// Compact rows sit inside the SwipeableRow stub, which drops their listitem role, so look inside the list.
const chipsIn = (container) => [...container.querySelectorAll("[role=list] span[title]")].map((chip) => [chip.textContent, chip.title]);

test("All inboxes lists and counts every mailbox and leaves follow-ups to each Inbox", async (t) => {
	const page = await renderPage(allInboxesFolderConfig);
	t.after(page.cleanup);
	assert.ok(globalThis.__listScopes.length > 0);
	assert.ok(globalThis.__listScopes.every((scope) => scope === null), "the list asks for every mailbox");
	assert.ok(globalThis.__countScopes.every((scope) => scope === null), "the counts cover every mailbox");
	assert.equal(globalThis.__followUpsRendered, false);
	assert.doesNotMatch(document.title, /@/, "the tab title names no single mailbox");
});

test("the Inbox still lists, counts and follows up on the selected mailbox only", async (t) => {
	const page = await renderPage(inboxFolderConfig);
	t.after(page.cleanup);
	assert.ok(globalThis.__listScopes.every((scope) => scope === "support"));
	assert.ok(globalThis.__countScopes.every((scope) => scope === "support"));
	assert.equal(globalThis.__followUpsRendered, true);
	assert.deepEqual(chipsIn(page.container), [], "no chips outside All inboxes");
});

test("each row names its mailbox and cannot be dragged to a folder", async (t) => {
	const desktop = await renderPage(allInboxesFolderConfig, { compact: false });
	t.after(desktop.cleanup);
	assert.deepEqual(chipsIn(desktop.container), [["Support", "support@example.com"], ["billing", "billing@example.com"]]);
	assert.equal(desktop.container.querySelector('[draggable="true"]'), null);

	const compact = await renderPage(allInboxesFolderConfig);
	t.after(compact.cleanup);
	assert.deepEqual(chipsIn(compact.container), [["Support", "support@example.com"], ["billing", "billing@example.com"]]);
	assert.equal(compact.container.querySelector('[draggable="true"]'), null);
});

test("Inbox rows stay draggable", async (t) => {
	const page = await renderPage(inboxFolderConfig, { compact: false });
	t.after(page.cleanup);
	assert.ok(page.container.querySelector('[draggable="true"]'));
});

test("the bulk toolbar hides custom folders in All inboxes only", async (t) => {
	const all = await renderPage(allInboxesFolderConfig, { compact: false });
	t.after(all.cleanup);
	await act(async () => all.container.querySelector('[role=listitem] input[type="checkbox"]').click());
	assert.equal(globalThis.__toolbarProps?.hideCustomFolders, true);

	const inbox = await renderPage(inboxFolderConfig, { compact: false });
	t.after(inbox.cleanup);
	await act(async () => inbox.container.querySelector('[role=listitem] input[type="checkbox"]').click());
	assert.ok(globalThis.__toolbarProps, "selecting a row shows the toolbar");
	assert.ok(!globalThis.__toolbarProps.hideCustomFolders);
});

test("marking a row read moves only its own mailbox's unread count", async (t) => {
	const deltas = [];
	const listener = (event) => deltas.push(event.detail);
	window.addEventListener("mailflare:message-counts-delta", listener);
	t.after(() => window.removeEventListener("mailflare:message-counts-delta", listener));
	const page = await renderPage(allInboxesFolderConfig);
	t.after(page.cleanup);
	await act(async () => {
		page.container.querySelector('[aria-label="stub-read"][data-message-id="b1"]').click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.deepEqual(deltas, [{ inboxUnreadDelta: -1, mailboxId: "billing" }]);
});

test("the split view's action bar passes hideCustomFolders to its toolbar", async (t) => {
	globalThis.__toolbarProps = null;
	const bar = await mount(createElement(BulkMessageActionBar, {
		folder: "inbox",
		hideCustomFolders: true,
		selectedMessages: [{ id: "b1", read: false }],
		onClearSelection() {},
	}));
	t.after(bar.cleanup);
	assert.equal(globalThis.__toolbarProps.hideCustomFolders, true);
});

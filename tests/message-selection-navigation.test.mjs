import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-message-selection-"));
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
globalThis.ResizeObserver = class {
	observe() {}
	disconnect() {}
};

const mock = new Map([
	["next/navigation", `
import React from "react";
let pathname = "/inbox";
const listeners = new Set();
globalThis.__setTestPathname = (next) => {
  pathname = next;
  for (const listener of listeners) listener();
};
export function usePathname() {
  const [value, setValue] = React.useState(pathname);
  React.useEffect(() => {
    const listener = () => setValue(pathname);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return value;
}
export function useRouter() {
  return {
    push(next) { globalThis.__setTestPathname(next); },
    replace(next) { globalThis.__setTestPathname(next); },
  };
}
export function useParams() { return {}; }
`],
	["next/link", `
import React from "react";
export default function Link({ href, children, ...props }) {
  return React.createElement("a", { href, ...props }, children);
}
`],
	["@/components/language-provider", `
export function useLanguage() {
  return {
    t(key, vars) {
      return vars && vars.count !== undefined ? key + ":" + vars.count : key;
    },
  };
}
`],
	["@/components/mail-search/mail-search-context", `
export function useMailSearch() {
  return { query: "", input: "", setQuery() {} };
}
`],
	["@/components/mailbox-provider", `
export function useSelectedMailbox() {
  return globalThis.__testMailboxState;
}
`],
	["@/hooks/use-messages", `
export function useMessages(folder, mailboxId, filters) {
  return globalThis.__testMessageList(filters);
}
`],
	["@/hooks/use-message-counts", `
export function useMessageCounts() {
  return {
    counts: {
      folders: { inbox: { total: 30, unread: 30 } },
      customFolders: {},
      mailboxes: [],
    },
    isLoading: false,
  };
}
`],
	["@/components/page-loading", `
export function usePageLoading() {}
`],
	["@/components/sidebar-mobile-utils", `
export function useIsMobile() { return false; }
export function useIsDesktop() { return globalThis.__testIsDesktop !== false; }
`],
	["@/components/messages/use-conversation-view", `
export function useConversationView() { return [true, () => {}]; }
`],
	["@/components/messages/use-two-column-reading", `
export function useTwoColumnReading() { return [true, () => {}]; }
`],
	["@/components/follow-ups/due-follow-ups", `
export function DueFollowUps() { return null; }
`],
]);

const relativeStub = `
import React from "react";
export function MessageDetailNavigationProvider({ children }) { return children; }
export function useMessageNavigation() { return { progress: null, onNavigate() {} }; }
export function MessageNavigationProgress() { return null; }
export function MessageListRowActions() { return null; }
export function SwipeableRow({ children }) { return children; }
`;

await build({
	stdin: {
		contents: `
			import React from "react";
			import { usePathname } from "next/navigation";
			import { MessageSplitLayout } from "./src/components/messages/message-split-layout.tsx";
			import { MessageFolderPage } from "./src/components/messages/message-folder-page.tsx";
			import { inboxFolderConfig } from "./src/components/messages/message-folder-configs.ts";

			export function Harness() {
				const pathname = usePathname();
				const detailPrefix = "/inbox/";
				const detailId = pathname.startsWith(detailPrefix) ? pathname.slice(detailPrefix.length) : null;
				return React.createElement(
					MessageSplitLayout,
					{ config: inboxFolderConfig },
					detailId
						? React.createElement("div", { "data-testid": "message-detail", "data-message-id": detailId }, "Message detail")
						: React.createElement(MessageFolderPage, { config: inboxFolderConfig }),
				);
			}
		`,
		resolveDir: root,
		sourcefile: "message-selection-entry.tsx",
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
		name: "message-selection-test-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => {
				if (mock.has(args.path)) return { path: args.path, namespace: "test-stub" };
				if (["./message-detail-navigation", "./message-navigation", "./message-list-row-actions", "./swipeable-row"].includes(args.path)) {
					return { path: "relative-stub", namespace: "test-relative-stub" };
				}
				return undefined;
			});
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => ({ contents: mock.get(args.path), loader: "tsx", resolveDir: root }));
			b.onLoad({ filter: /.*/, namespace: "test-relative-stub" }, () => ({ contents: relativeStub, loader: "tsx", resolveDir: root }));
		},
	}],
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Harness } = await import(pathToFileURL(join(temp, "entry.mjs")).href);

function message(id, read = false) {
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
		status: "inbox",
		read,
		starred: false,
		threadId: null,
		createdAt: "2026-10-01T10:00:00.000Z",
	};
}

const allMessages = Array.from({ length: 30 }, (_, index) => message(`m${index + 1}`, index > 0));

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

globalThis.__testMessageList = (filters) => {
	const offset = filters?.offset ?? 0;
	const messages = allMessages.slice(offset, offset + 25);
	return {
		messages,
		isLoading: false,
		total: allMessages.length,
		limit: 25,
		updateMessages() {},
	};
};

async function renderInbox({ desktop = true } = {}) {
	globalThis.__testIsDesktop = desktop;
	globalThis.__setTestPathname("/inbox");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	await act(async () => {
		reactRoot.render(createElement(Harness));
	});
	return {
		container,
		async cleanup() {
			await act(async () => reactRoot.unmount());
			container.remove();
		},
	};
}

function checkedBoxes(container) {
	return [...container.querySelectorAll('input[type="checkbox"]:checked')];
}

test("opening a message keeps the selection made while no message was open", async (t) => {
	const { container, cleanup } = await renderInbox();
	t.after(cleanup);

	const rowCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
	await act(async () => {
		rowCheckbox.click();
	});
	assert.equal(checkedBoxes(container).length, 1, "the row is selected before opening a message");

	await act(async () => {
		globalThis.__setTestPathname("/inbox/m1");
	});

	assert.equal(checkedBoxes(container).length, 1, "the sidebar list keeps the selected row");
	assert.ok(container.querySelector('[data-testid="message-detail"]'), "the focused message stays visible");
	assert.match(container.textContent, /common\.selectedCount:1/, "the bulk action bar reports one selected message");

	const clearSelection = container.querySelector('button[aria-label="common.clearSelection"]');
	assert.ok(clearSelection, "the bulk action bar offers a way to clear the selection");
	await act(async () => {
		clearSelection.click();
	});
	assert.ok(container.querySelector('[data-testid="message-detail"]'), "clearing the selection keeps the message visible");
	assert.equal(checkedBoxes(container).length, 0, "clearing the selection unchecks the sidebar row");
	assert.doesNotMatch(container.textContent, /common\.selectedCount:1/, "the bulk action bar disappears");
});

test("opening a message keeps the selection on a page other than the first", async (t) => {
	const { container, cleanup } = await renderInbox();
	t.after(cleanup);

	const nextPage = container.querySelector('button[aria-label="list.nextPage"]');
	assert.ok(nextPage, "the first page has a next-page button");
	await act(async () => {
		nextPage.click();
	});

	const rowCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
	await act(async () => {
		rowCheckbox.click();
	});
	assert.equal(checkedBoxes(container).length, 1, "a row on the second page is selected");

	await act(async () => {
		globalThis.__setTestPathname("/inbox/m26");
	});

	assert.equal(checkedBoxes(container).length, 1, "the sidebar list stays on the same page and keeps the selected row");
	assert.ok(container.querySelector('[data-testid="message-detail"]'), "the focused message stays visible on the second page too");
});

test("the focused-message bulk bar stays in the split view", async (t) => {
	const { container, cleanup } = await renderInbox({ desktop: false });
	t.after(cleanup);

	const rowCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
	await act(async () => {
		rowCheckbox.click();
	});

	await act(async () => {
		globalThis.__setTestPathname("/inbox/m1");
	});

	assert.ok(container.querySelector('[data-testid="message-detail"]'), "single-column reading still opens the message");
	assert.equal(checkedBoxes(container).length, 1, "the selection survives");
	assert.equal(container.querySelector('[role="region"]'), null, "the bulk bar is hidden without a visible split list");
});

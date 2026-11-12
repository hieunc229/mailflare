import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act } from "react";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-undo-toast-ui-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "https://mail.example/inbox",
	pretendToBeVisual: true,
});
after(() => dom.window.close());
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "HTMLInputElement"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { createRoot } from "react-dom/client";
			import { act } from "react";
			import { LanguageProvider } from "@/components/language-provider";
			import { UndoToasts } from "@/components/messages/undo-toasts";
			import * as store from "@/lib/messages/actions/undo-store";
			export { MessageActionRequestError } from "@/lib/messages/actions/client";
			export { act };
			export function showUndoToast(input) { return store.showUndoToast(input); }
			export function resetStore() { store.resetUndoToastsForTests(); }
			export async function flush() {
				await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
			}
			export async function mount() {
				document.body.replaceChildren();
				const main = document.createElement("main");
				main.id = "main-content";
				main.tabIndex = -1;
				document.body.appendChild(main);
				const container = document.createElement("div");
				document.body.appendChild(container);
				const root = createRoot(container);
				await act(async () => {
					root.render(createElement(LanguageProvider, { initialLocale: "en" }, createElement(UndoToasts)));
				});
				return {
					container,
					async unmount() { await act(async () => root.unmount()); },
				};
			}
		`,
		resolveDir: root,
		loader: "tsx",
	},
	outfile: join(directory, "ui.mjs"),
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
			name: "undo-client-stub",
			setup(builder) {
				builder.onResolve({ filter: /^@\/lib\/messages\/actions\/client$/ }, () => ({ path: "client", namespace: "undo-stub" }));
				builder.onLoad({ filter: /.*/, namespace: "undo-stub" }, () => ({
					contents: `
						export class MessageActionRequestError extends Error {
							constructor(message, status = 400) {
								super(message);
								this.status = status;
								this.name = "MessageActionRequestError";
							}
						}
						export function undoMessageAction(entry) {
							return globalThis.undoHandler(entry);
						}
					`,
					loader: "js",
				}));
			},
		},
		{
			name: "runtime-stubs",
			setup(builder) {
				builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
			},
		},
	],
});

const ui = await import(pathToFileURL(join(directory, "ui.mjs")).href);
const { MessageActionRequestError } = ui;

const state = (overrides = {}) => ({
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});

const record = (id, action = "read") => ({
	id,
	mailboxId: "mb1",
	previous: state(),
	applied: action === "star" ? state({ starred: true }) : state({ read: true }),
});

function reset() {
	ui.resetStore();
	globalThis.undoHandler = undefined;
	document.body.replaceChildren();
}

function show({ action = "archive", records = [record("m1")], token = "token-1", context } = {}) {
	return ui.showUndoToast({ action, records, undoToken: token, ...(context ? { context } : {}) });
}

async function mount(t) {
	reset();
	const app = await ui.mount();
	t.after(async () => { await app.unmount(); reset(); });
	return app;
}

function toast(container, id) {
	return container.querySelector(`[data-undo-toast-id="${id}"]`);
}

function buttonByText(container, text) {
	return [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
}

test("live regions stay mounted while empty and applied actions announce politely", async (t) => {
	const app = await mount(t);
	const status = app.container.querySelector('[role="status"]');
	const alert = app.container.querySelector('[role="alert"]');
	assert.ok(status, "polite live region is always mounted");
	assert.ok(alert, "assertive live region is always mounted");
	assert.equal(status.getAttribute("aria-live"), "polite");
	assert.equal(alert.getAttribute("aria-live"), "assertive");
	assert.equal(status.textContent, "");
	assert.equal(alert.textContent, "");

	const id = await act(async () => show({ context: "Receipts" }));
	await ui.flush();
	assert.match(status.textContent, /Archived/);
	assert.equal(alert.textContent, "");

	const card = toast(app.container, id);
	assert.ok(card);
	assert.match(card.textContent, /Receipts/);
	const describedBy = card.querySelector("button").getAttribute("aria-describedby");
	assert.equal(describedBy, `undo-toast-${id}-message`);
	assert.ok(card.querySelector(`#${describedBy}`));
});

test("the stack anchors in the content column, clears the mobile compose button and is keyboard reachable", async (t) => {
	const app = await mount(t);
	await act(async () => show());
	await ui.flush();
	const region = app.container.querySelector('[role="region"]');
	assert.ok(region);
	assert.equal(region.tabIndex, 0);
	assert.equal(region.getAttribute("aria-label"), "Message action notifications");
	const classes = region.className;
	assert.match(classes, /z-40/);
	assert.match(classes, /--sidebar-width/);
	assert.match(classes, /bottom-\[max\(5rem/);
	assert.match(classes, /env\(safe-area-inset-bottom/);

	const close = app.container.querySelector('button[aria-label="Dismiss"]');
	assert.match(close.className, /h-6/);
	assert.match(close.className, /w-6/);
	assert.match(close.className, /focus-visible:ring-2/);
});

test("undo pending shows a spinner and busy label, and locks dismissal", async (t) => {
	const app = await mount(t);
	let finish;
	globalThis.undoHandler = () => new Promise((resolve) => { finish = resolve; });
	const id = await act(async () => show());
	await ui.flush();

	const card = toast(app.container, id);
	const undo = buttonByText(card, "Undo");
	await act(async () => { undo.click(); });
	await ui.flush();

	assert.equal(card.getAttribute("aria-busy"), "true");
	assert.match(card.textContent, /Undoing…/);
	assert.equal(buttonByText(card, "Undoing…").getAttribute("aria-disabled"), "true");
	const close = card.querySelector('button[aria-label="Dismiss"]');
	assert.equal(close.disabled, true, "dismiss cannot pretend to cancel a request already in flight");
	assert.ok(card.querySelector(".animate-spin"));

	await act(async () => { finish({ ok: true, action: "archive", restored: ["m1"], skipped: [] }); });
	await ui.flush();
	assert.equal(toast(app.container, id), null);
	assert.match(app.container.querySelector('[role="status"]').textContent, /Undo complete: Archived/);
	assert.equal(document.activeElement, document.getElementById("main-content"));
});

test("a transient server failure persists and Retry starts the same undo again", async (t) => {
	const app = await mount(t);
	let attempt = 0;
	globalThis.undoHandler = async () => {
		attempt += 1;
		if (attempt === 1) throw new MessageActionRequestError("Temporary failure", 503);
		return { ok: true, action: "archive", restored: ["m1"], skipped: [] };
	};
	const id = await act(async () => show());
	await ui.flush();

	await act(async () => { buttonByText(toast(app.container, id), "Undo").click(); });
	await ui.flush();
	const card = toast(app.container, id);
	assert.ok(card, "a failed undo remains visible");
	assert.match(card.textContent, /Could not undo that change/);
	assert.match(card.textContent, /Undo failed\. Please try again\./);
	assert.match(app.container.querySelector('[role="alert"]').textContent, /Undo failed/);
	const retry = buttonByText(card, "Try again");
	assert.ok(retry, "transient failures offer Retry");

	await act(async () => { retry.click(); });
	await ui.flush();
	assert.equal(toast(app.container, id), null);
	assert.equal(attempt, 2);
	assert.match(app.container.querySelector('[role="status"]').textContent, /Undo complete/);
});

test("expired undos persist without Retry and announce the actual reason", async (t) => {
	const app = await mount(t);
	globalThis.undoHandler = async () => { throw new MessageActionRequestError("This undo has expired", 410); };
	const id = await act(async () => show());
	await ui.flush();

	await act(async () => { buttonByText(toast(app.container, id), "Undo").click(); });
	await ui.flush();
	const card = toast(app.container, id);
	assert.ok(card);
	assert.match(card.textContent, /This undo has expired\./);
	assert.equal(buttonByText(card, "Try again"), undefined);
	assert.match(app.container.querySelector('[role="alert"]').textContent, /This undo has expired/);
});

test("stale skipped results stay persistent and do not pretend the action was undone", async (t) => {
	const app = await mount(t);
	globalThis.undoHandler = async () => ({
		ok: true,
		action: "archive",
		restored: [],
		skipped: [{ id: "m1", reason: "stale" }],
	});
	const id = await act(async () => show());
	await ui.flush();

	await act(async () => { buttonByText(toast(app.container, id), "Undo").click(); });
	await ui.flush();
	const card = toast(app.container, id);
	assert.ok(card);
	assert.match(card.textContent, /message changed/);
	assert.equal(buttonByText(card, "Try again"), undefined);
	assert.match(app.container.querySelector('[role="alert"]').textContent, /message changed/);
});

test("a partial restore shows its own notice and announcement, not full success", async (t) => {
	const app = await mount(t);
	globalThis.undoHandler = async () => ({
		ok: true,
		action: "archive",
		restored: ["m1"],
		skipped: [{ id: "m2", reason: "failed" }],
	});
	const records = [record("m1"), record("m2")];
	const id = await act(async () => show({ records }));
	await ui.flush();

	await act(async () => { buttonByText(toast(app.container, id), "Undo").click(); });
	await ui.flush();
	const card = toast(app.container, id);
	assert.ok(card, "a partial restore stays visible");
	assert.match(card.textContent, /1 of 2 messages restored\. The rest could not be undone\./);
	assert.equal(buttonByText(card, "Try again"), undefined, "retrying the whole token is not offered after a partial restore");
	assert.match(app.container.querySelector('[role="alert"]').textContent, /1 of 2 messages restored/);
	assert.doesNotMatch(app.container.querySelector('[role="status"]').textContent, /Undo complete/);
});

test("dismissing removes a toast and returns focus to main content", async (t) => {
	const app = await mount(t);
	const id = await act(async () => show());
	await ui.flush();
	const card = toast(app.container, id);
	const close = card.querySelector('button[aria-label="Dismiss"]');
	close.focus();
	assert.equal(document.activeElement, close);

	await act(async () => { close.click(); });
	await ui.flush();
	assert.equal(toast(app.container, id), null);
	assert.equal(document.activeElement, document.getElementById("main-content"));
});

test("the passive stack becomes inert and hidden from assistive tech while a modal is open", async (t) => {
	const app = await mount(t);
	await act(async () => show());
	await ui.flush();
	const region = app.container.querySelector('[role="region"]');
	assert.equal(region.hasAttribute("inert"), false);

	const overlay = document.createElement("div");
	overlay.className = "dialog-overlay";
	document.body.appendChild(overlay);
	await ui.flush();
	assert.equal(region.hasAttribute("inert"), true);
	assert.equal(region.getAttribute("aria-hidden"), "true");
	assert.match(region.textContent, /Archived/, "the toast remains visible under the modal layer");

	overlay.remove();
	await ui.flush();
	assert.equal(region.hasAttribute("inert"), false);
	assert.equal(region.getAttribute("aria-hidden"), null);
});

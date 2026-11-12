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

function installWindowClock() {
	const originalSetTimeout = window.setTimeout;
	const originalClearTimeout = window.clearTimeout;
	const originalNow = Date.now;
	let now = 1_000;
	let nextId = 0;
	let timers = [];
	window.setTimeout = (callback, delay = 0) => {
		const id = ++nextId;
		timers.push({ id, at: now + Number(delay), callback });
		return id;
	};
	window.clearTimeout = (id) => {
		timers = timers.filter((timer) => timer.id !== id);
	};
	Date.now = () => now;
	return {
		advance(ms) {
			now += ms;
			for (;;) {
				const due = timers
					.filter((timer) => timer.at <= now)
					.sort((a, b) => a.at - b.at || a.id - b.id)[0];
				if (!due) return;
				timers = timers.filter((timer) => timer !== due);
				due.callback();
			}
		},
		restore() {
			window.setTimeout = originalSetTimeout;
			window.clearTimeout = originalClearTimeout;
			Date.now = originalNow;
		},
	};
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
	assert.match(classes, /z-30/);
	assert.match(classes, /--sidebar-width/);
	assert.match(classes, /bottom-\[max\(5rem/);
	assert.match(classes, /env\(safe-area-inset-bottom/);

	const close = app.container.querySelector('button[aria-label="Dismiss"]');
	assert.match(close.className, /h-6/);
	assert.match(close.className, /w-6/);
	assert.match(close.className, /focus-visible:ring-2/);
});

test("undo pending shows a spinner and busy label with a hide action", async (t) => {
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
	const hide = card.querySelector('button[aria-label="Hide notification (undo continues)"]');
	assert.ok(hide, "a pending notice can be hidden without pretending to cancel it");
	assert.equal(hide.disabled, false);
	assert.ok(card.querySelector(".animate-spin"));

	await act(async () => { finish({ ok: true, action: "archive", restored: ["m1"], skipped: [] }); });
	await ui.flush();
	assert.equal(toast(app.container, id), null);
	assert.match(app.container.querySelector('[role="status"]').textContent, /Undo complete: Archived/);
	assert.equal(document.activeElement, document.getElementById("main-content"));
});

test("hiding a pending notice removes it while Undo continues", async (t) => {
	const app = await mount(t);
	let finish;
	globalThis.undoHandler = () => new Promise((resolve) => { finish = resolve; });
	const id = await act(async () => show());
	await ui.flush();

	await act(async () => { buttonByText(toast(app.container, id), "Undo").click(); });
	await ui.flush();
	const hide = toast(app.container, id).querySelector('button[aria-label="Hide notification (undo continues)"]');
	hide.focus();
	await act(async () => { hide.click(); });
	await ui.flush();
	assert.equal(toast(app.container, id), null);
	assert.equal(document.activeElement, document.getElementById("main-content"));

	await act(async () => { finish({ ok: true, action: "archive", restored: ["m1"], skipped: [] }); });
	await ui.flush();
	assert.equal(toast(app.container, id), null);
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
	assert.equal(document.activeElement, card.querySelector("[data-undo-dismiss]"));
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
	assert.equal(document.activeElement, card.querySelector("[data-undo-dismiss]"), "focus stays on the receipt");
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

test("focus falls back to a visible app surface when main is inert", async (t) => {
	const app = await mount(t);
	const assistant = document.createElement("section");
	assistant.id = "email-assistant-panel";
	document.body.appendChild(assistant);
	const id = await act(async () => show());
	await ui.flush();
	const close = toast(app.container, id).querySelector('button[aria-label="Dismiss"]');
	close.focus();

	await act(async () => {
		close.click();
		const main = document.getElementById("main-content");
		main.setAttribute("inert", "");
		main.setAttribute("aria-hidden", "true");
	});
	await ui.flush();
	assert.equal(toast(app.container, id), null);
	assert.equal(document.activeElement, assistant);
	assistant.remove();
});

test("removing a focused toast resumes the remaining region countdown", async (t) => {
	const app = await mount(t);
	const clock = installWindowClock();
	t.after(() => clock.restore());

	const first = await act(async () => show({ token: "first" }));
	const second = await act(async () => show({ token: "second" }));
	await ui.flush();
	const close = toast(app.container, first).querySelector('button[aria-label="Dismiss"]');
	close.focus();
	assert.equal(document.activeElement, close);
	await act(async () => { close.click(); });
	await ui.flush();
	await act(async () => { clock.advance(0); });
	await ui.flush();
	assert.equal(toast(app.container, first), null);
	assert.equal(document.activeElement, document.getElementById("main-content"));
	await act(async () => { clock.advance(19_999); });
	assert.ok(toast(app.container, second), "the remaining toast still has its countdown");
	await act(async () => { clock.advance(1); });
	assert.equal(toast(app.container, second), null);

	globalThis.undoHandler = async () => ({ ok: true, action: "archive", restored: ["m1"], skipped: [] });
	const third = await act(async () => show({ token: "third" }));
	const fourth = await act(async () => show({ token: "fourth" }));
	await ui.flush();
	const undo = buttonByText(toast(app.container, third), "Undo");
	undo.focus();
	await act(async () => { undo.click(); });
	await ui.flush();
	await act(async () => { clock.advance(0); });
	assert.equal(toast(app.container, third), null);
	assert.equal(document.activeElement, document.getElementById("main-content"));
	await act(async () => { clock.advance(19_999); });
	assert.ok(toast(app.container, fourth));
	await act(async () => { clock.advance(1); });
	assert.equal(toast(app.container, fourth), null);
});

test("a compose surface holds countdowns without blocking the toast", async (t) => {
	const app = await mount(t);
	const clock = installWindowClock();
	t.after(() => clock.restore());
	const id = await act(async () => show());
	await ui.flush();

	const compose = document.createElement("form");
	compose.dataset.composeSurface = "";
	document.body.appendChild(compose);
	await ui.flush();
	const region = app.container.querySelector('[role="region"]');
	assert.equal(region.hasAttribute("inert"), false, "the non-modal composer pauses timers but leaves the toast available");
	await act(async () => { clock.advance(60_000); });
	assert.ok(toast(app.container, id));

	compose.remove();
	await ui.flush();
	await act(async () => { clock.advance(19_999); });
	assert.ok(toast(app.container, id));
	await act(async () => { clock.advance(1); });
	assert.equal(toast(app.container, id), null);
});

test("focusing the notification region pauses every countdown", async (t) => {
	const app = await mount(t);
	const clock = installWindowClock();
	t.after(() => clock.restore());
	const id = await act(async () => show());
	await ui.flush();
	const region = app.container.querySelector('[role="region"]');
	region.focus();
	assert.equal(document.activeElement, region);

	await act(async () => { clock.advance(60_000); });
	assert.ok(toast(app.container, id), "a focused region holds all undo countdowns");

	const outside = document.createElement("button");
	document.body.appendChild(outside);
	outside.focus();
	await act(async () => { clock.advance(19_999); });
	assert.ok(toast(app.container, id));
	await act(async () => { clock.advance(1); });
	assert.equal(toast(app.container, id), null);
	outside.remove();
});

test("a modal, mobile sidebar or hidden main surface holds idle countdowns", async (t) => {
	const app = await mount(t);
	const clock = installWindowClock();
	t.after(() => clock.restore());
	const id = await act(async () => show());
	await ui.flush();
	const region = app.container.querySelector('[role="region"]');
	assert.equal(region.hasAttribute("inert"), false);

	const overlay = document.createElement("div");
	overlay.className = "dialog-overlay";
	document.body.appendChild(overlay);
	await ui.flush();
	assert.equal(region.hasAttribute("inert"), true);
	await act(async () => { clock.advance(60_000); });
	assert.ok(toast(app.container, id), "a modal holds the countdown");

	const mobileMenu = document.createElement("button");
	mobileMenu.dataset.mobileMenu = "";
	mobileMenu.setAttribute("aria-expanded", "true");
	document.body.appendChild(mobileMenu);
	overlay.remove();
	await ui.flush();
	assert.equal(region.hasAttribute("inert"), true, "the mobile sidebar still owns interaction");
	await act(async () => { clock.advance(60_000); });
	assert.ok(toast(app.container, id));

	mobileMenu.setAttribute("aria-expanded", "false");
	await ui.flush();
	assert.equal(region.hasAttribute("inert"), false);
	await act(async () => { clock.advance(19_999); });
	assert.ok(toast(app.container, id));
	await act(async () => { clock.advance(1); });
	assert.equal(toast(app.container, id), null);
	mobileMenu.remove();
});

test("an inert or hidden main surface also holds idle countdowns", async (t) => {
	const app = await mount(t);
	const clock = installWindowClock();
	t.after(() => clock.restore());
	const id = await act(async () => show());
	await ui.flush();
	const main = document.getElementById("main-content");
	main.setAttribute("inert", "");
	main.setAttribute("aria-hidden", "true");
	await ui.flush();
	const region = app.container.querySelector('[role="region"]');
	assert.equal(region.hasAttribute("inert"), true);
	await act(async () => { clock.advance(60_000); });
	assert.ok(toast(app.container, id));

	main.removeAttribute("inert");
	main.removeAttribute("aria-hidden");
	await ui.flush();
	await act(async () => { clock.advance(19_999); });
	assert.ok(toast(app.container, id));
	await act(async () => { clock.advance(1); });
	assert.equal(toast(app.container, id), null);
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

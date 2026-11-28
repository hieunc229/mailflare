import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadComponent } from "./helpers/dom-component.mjs";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-keyboard-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { isTypingInInput, hasOpenDialogOrMenu } from "./src/components/shortcuts/keyboard-guards.ts"; export { createSequenceState, recordKey, matchSequence } from "./src/components/shortcuts/hotkey-sequence.ts";`,
		resolveDir: root,
		sourcefile: "keyboard-shortcuts-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { isTypingInInput, hasOpenDialogOrMenu, createSequenceState, recordKey, matchSequence } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.HTMLElement = dom.window.HTMLElement;

 test("typing targets suppress shortcuts, including role=textbox and editable regions", () => {
	for (const markup of ["<input>", "<textarea>", "<div contenteditable='true'></div>", "<div role='textbox'></div>", "<div role='combobox'><span></span></div>"]) {
		const target = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
		target.innerHTML = markup;
		assert.equal(isTypingInInput(target.firstElementChild?.firstElementChild ?? target.firstElementChild), true, markup);
		target.remove();
	}
	assert.equal(isTypingInInput(dom.window.document.body), false);
});

test("an open dialog or menu suppresses global shortcuts", () => {
	const doc = dom.window.document;
	assert.equal(hasOpenDialogOrMenu(doc), false);
	const dialog = doc.createElement("div");
	dialog.setAttribute("aria-modal", "true");
	doc.body.append(dialog);
	assert.equal(hasOpenDialogOrMenu(doc), true);
	dialog.remove();
	const menu = doc.createElement("div");
	menu.setAttribute("role", "menu");
	doc.body.append(menu);
	assert.equal(hasOpenDialogOrMenu(doc), true);
	menu.remove();
});

test("sequence dispatch buffers g then s and resolves the sent binding", () => {
	const state = createSequenceState();
	const sent = { key: "g s", action() {} };
	const ref = { current: [sent] };
	state.refs.add(ref);
	assert.equal(recordKey(state, {}, "g"), true);
	assert.equal(matchSequence(state, ref.current), undefined);
	assert.equal(recordKey(state, {}, "s"), true);
	assert.equal(matchSequence(state, ref.current), sent);
});

test("Enter on a native button leaves activation to the browser", async (t) => {
	const { useHotkeys } = await loadComponent("src/components/shortcuts/use-hotkeys.ts");
	const container = document.body.appendChild(document.createElement("div")), root = createRoot(container), dispatches = [];
	const listener = () => dispatches.push(true);
	window.addEventListener("mailflare:message-list-shortcut", listener);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); window.removeEventListener("mailflare:message-list-shortcut", listener); });
	function App() { useHotkeys([{ key: "enter", label: "Open", category: "Navigation", action: () => window.dispatchEvent(new window.CustomEvent("mailflare:message-list-shortcut")) }]); return createElement("button"); }
	await act(async () => root.render(createElement(App)));
	const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
	container.querySelector("button").dispatchEvent(event);
	assert.equal(event.defaultPrevented, false);
	assert.deepEqual(dispatches, []);
});

test("Escape back does not navigate from a non-message route", async (t) => {
	globalThis.__keyboardPushes = [];
	const { useMessageListShortcuts } = await loadComponent("src/components/messages/use-message-list-shortcuts.ts", { "next/navigation": `export const usePathname=()=>"/agent/review/123"; export const useRouter=()=>({push:path=>globalThis.__keyboardPushes.push(path)});` });
	const container = document.body.appendChild(document.createElement("div")), root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); delete globalThis.__keyboardPushes; });
	function App() { useMessageListShortcuts(); return null; }
	await act(async () => root.render(createElement(App)));
	window.dispatchEvent(new window.CustomEvent("mailflare:message-list-shortcut", { detail: "back" }));
	assert.deepEqual(globalThis.__keyboardPushes, []);
});

test("escaping a message detail restores focus to the row that was open", async (t) => {
	globalThis.__keyboardPathname = "/inbox/2";
	const { useMessageListShortcuts } = await loadComponent("src/components/messages/use-message-list-shortcuts.ts", { "next/navigation": `export const usePathname=()=>globalThis.__keyboardPathname; export const useRouter=()=>({push() {}});` });
	const container = document.body.appendChild(document.createElement("div")), rows = document.body.appendChild(document.createElement("div")), root = createRoot(container);
	rows.innerHTML = '<a href="/inbox/1">one</a><a href="/inbox/2">two</a>';
	t.after(async () => { await act(async () => root.unmount()); container.remove(); rows.remove(); delete globalThis.__keyboardPathname; });
	function App() { useMessageListShortcuts(); return null; }
	await act(async () => root.render(createElement(App)));
	assert.equal(document.activeElement, document.body);
	globalThis.__keyboardPathname = "/inbox";
	await act(async () => root.render(createElement(App)));
	assert.equal(document.activeElement, rows.querySelector('a[href="/inbox/2"]'));
});

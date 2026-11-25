import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath, pathToFileURL } from "node:url";

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

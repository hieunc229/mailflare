import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-compose-insert-link-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
document.queryCommandState = () => false;
document.queryCommandValue = () => "";

await build({
	entryPoints: [join(root, "src/components/compose/rich-text-editor.tsx")],
	outfile: join(outDir, "editor.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	external: ["react", "react-dom", "react-dom/*"],
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RichTextEditor } = await import(pathToFileURL(join(outDir, "editor.mjs")).href);

async function setup(t, selected = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	t.after(async () => {
		await act(async () => reactRoot.unmount());
		container.remove();
	});
	let submits = 0;
	const commands = [];
	document.execCommand = (command, _showUi, value) => {
		commands.push({ command, value, selection: window.getSelection().toString() });
		return true;
	};
	await act(async () => {
		reactRoot.render(createElement("form", {
			onSubmit(event) {
				event.preventDefault();
				submits++;
			},
		}, createElement(RichTextEditor, { value: "Read this", onChange() {} })));
	});
	const editor = container.querySelector('[role="textbox"]');
	editor.focus();
	const range = document.createRange();
	range.setStart(editor.firstChild, selected ? 0 : 9);
	range.setEnd(editor.firstChild, 9);
	window.getSelection().removeAllRanges();
	window.getSelection().addRange(range);
	await act(async () => container.querySelector('[aria-label="Insert link"]').click());
	const input = container.querySelector('input[placeholder="https://example.com"]');
	assert.ok(input);
	assert.equal(container.querySelectorAll("form").length, 1, "the popup must not nest a form inside the composer");
	return {
		commands,
		async fill(value) {
			await act(async () => {
				Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
				input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			});
		},
		async apply(key) {
			let event;
			await act(async () => {
				if (key) {
					event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
					input.dispatchEvent(event);
				} else {
					Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Apply").click();
				}
			});
			assert.equal(submits, 0, "inserting a link must not submit the composer");
			assert.equal(container.querySelector('input[placeholder="https://example.com"]'), null, "the popup closes");
			return event;
		},
	};
}

test("Apply inserts a URL at the caret without submitting the compose form", async (t) => {
	const popup = await setup(t);
	await popup.fill(" example.com ");
	await popup.apply();
	assert.deepEqual(popup.commands, [{ command: "insertHTML", value: '<a href="https://example.com">https://example.com</a>', selection: "" }]);
});

test("Enter links the saved text selection and prevents implicit form submission", async (t) => {
	const popup = await setup(t, true);
	await popup.fill("https://example.com/read");
	const event = await popup.apply("Enter");
	assert.equal(event.defaultPrevented, true);
	assert.deepEqual(popup.commands, [{ command: "createLink", value: "https://example.com/read", selection: "Read this" }]);
});

test("Apply with a blank URL closes the popup without inserting or submitting", async (t) => {
	const popup = await setup(t);
	await popup.fill("   ");
	await popup.apply();
	assert.deepEqual(popup.commands, []);
});

test("Escape cancels link insertion", async (t) => {
	const popup = await setup(t);
	await popup.fill("https://example.com");
	await popup.apply("Escape");
	assert.deepEqual(popup.commands, []);
});

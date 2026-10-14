import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-custom-combobox-"));
const outfile = join(outDir, "combobox.mjs");
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const name of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent", "MutationObserver"]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
await build({ stdin: { contents: `import React, { act } from "react"; import { createRoot } from "react-dom/client"; import { CustomCombobox } from "./src/components/ui/custom-combobox"; export { React, act, createRoot, CustomCombobox };`, resolveDir: root, loader: "tsx" }, outfile, bundle: true, platform: "browser", format: "esm", target: "es2022", tsconfig: join(root, "tsconfig.json"), external: ["react", "react-dom", "react-dom/client"], alias: { "@": join(root, "src") }, logLevel: "silent" });
const { React, act, createRoot, CustomCombobox } = await import(pathToFileURL(outfile).href);
const h = React.createElement;

async function mount(element) {
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container); await act(async () => root.render(element));
	return { container, async cleanup() { await act(async () => root.unmount()); container.remove(); } };
}

function type(input, value) {
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("filters suggestions and commits keyboard selection while preserving input value", async () => {
	function Fixture() { const [value, setValue] = React.useState(""); return h(CustomCombobox, { value, onChange: setValue, options: ["Asia/Kolkata", "America/Chicago"] }); }
	const view = await mount(h(Fixture));
	const input = view.container.querySelector("input[role=combobox]");
	await act(async () => type(input, "kol"));
	assert.equal(input.value, "kol");
	assert.equal(document.querySelectorAll('[role="option"]').length, 1);
	await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true } )));
	await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true } )));
	assert.equal(input.value, "Asia/Kolkata");
	assert.equal(input.getAttribute("aria-expanded"), "false");
	await view.cleanup();
});

test("keeps freeform and empty values available for settings fields", async () => {
	const changes = [];
	function Fixture() { const [value, setValue] = React.useState(""); return h(CustomCombobox, { value, onChange: (next) => { changes.push(next); setValue(next); }, options: ["us-east-1", "us-west-2"], "aria-label": "Region" }); }
	const view = await mount(h(Fixture));
	const input = view.container.querySelector("input[role=combobox]");
	await act(async () => type(input, "custom-region-1"));
	assert.equal(changes.at(-1), "custom-region-1");
	await act(async () => type(input, ""));
	assert.equal(changes.at(-1), "");
	assert.equal(input.value, "");
	assert.equal(input.getAttribute("aria-label"), "Region");
	await view.cleanup();
});

test("suggestions escape clipping parents and flip above when below has no room", async () => {
	const view = await mount(h("div", { style: { overflow: "hidden" } }, h(CustomCombobox, { value: "", onChange: () => {}, options: ["Asia/Kolkata", "America/Chicago", "Europe/London"] })));
	const input = view.container.querySelector("input");
	input.getBoundingClientRect = () => ({ top: 710, bottom: 750, left: 24, width: 300, height: 40 });
	await act(async () => { input.focus(); });
	const popup = document.querySelector('[data-ui-popup="combobox"]');
	assert.ok(popup);
	assert.equal(view.container.contains(popup), false);
	assert.equal(popup.style.width, "300px");
	assert.equal(popup.style.top, "");
	assert.equal(popup.style.bottom, `${window.innerHeight - 710 + 8}px`);
	await view.cleanup();
});

test("suggestions open below when it fits and follow resize", async () => {
	const view = await mount(h(CustomCombobox, { value: "", onChange: () => {}, options: ["Asia/Kolkata"] }));
	const input = view.container.querySelector("input");
	input.getBoundingClientRect = () => ({ top: 40, bottom: 80, left: 24, width: 300, height: 40 });
	await act(async () => input.focus());
	const popup = document.querySelector('[data-ui-popup="combobox"]');
	assert.equal(popup.style.top, "88px");
	input.getBoundingClientRect = () => ({ top: 710, bottom: 750, left: 24, width: 240, height: 40 });
	await act(async () => window.dispatchEvent(new Event("resize")));
	assert.equal(popup.style.top, "");
	assert.equal(popup.style.width, "240px");
	await view.cleanup();
});

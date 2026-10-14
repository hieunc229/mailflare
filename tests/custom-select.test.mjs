import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-custom-select-"));
const outfile = join(outDir, "select.mjs");
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const name of ["window", "document", "HTMLElement", "HTMLSelectElement", "DocumentFragment", "Element", "Node", "Event", "CustomEvent", "FocusEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "FormData", "getComputedStyle"]) {
	globalThis[name] = name === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name];
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};

await build({
	stdin: {
		contents: `import React, { act } from "react";
		import { createRoot } from "react-dom/client";
		import { CustomSelect } from "./src/components/ui/custom-select";
		export { React, act, createRoot, CustomSelect };`,
		resolveDir: root,
		loader: "tsx",
	},
	outfile,
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	tsconfig: join(root, "tsconfig.json"),
	external: ["react", "react-dom", "react-dom/client"],
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { React, act, createRoot, CustomSelect } = await import(pathToFileURL(outfile).href);
const h = React.createElement;

async function mount(element) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return { container, async cleanup() { await act(async () => root.unmount()); container.remove(); } };
}

function options() {
	return [h("option", { key: "empty", value: "" }, "Choose one"), h("option", { key: "disabled", value: "blocked", disabled: true }, "Blocked"), h("option", { key: "ready", value: "ready" }, "Ready")];
}

test("native select keeps empty values, required validity, form data, and a forwarded ref", async () => {
	const ref = React.createRef();
	const view = await mount(h("form", null, h("label", { htmlFor: "state" }, "State"), h(CustomSelect, { id: "state", name: "state", required: true, defaultValue: "", ref }, options())));
	const native = document.getElementById("state");
	const trigger = view.container.querySelector("button[role=combobox]");
	assert.equal(ref.current, native);
	assert.equal(native.value, "");
	assert.equal(native.checkValidity(), false);
	assert.equal(new FormData(view.container.querySelector("form")).get("state"), "");
	assert.ok(trigger);
	assert.equal(trigger.getAttribute("aria-label"), "State");
	await act(async () => { native.focus(); });
	assert.equal(document.activeElement, trigger);
	await act(async () => { view.container.querySelector("label").click(); });
	assert.equal(trigger.getAttribute("aria-expanded"), "true");
	await view.cleanup();
});

test("custom selection calls native onChange and updates form data; reset restores default", async () => {
	const changes = [];
	const view = await mount(h("form", null, h(CustomSelect, { name: "state", defaultValue: "", "aria-label": "State", onChange: (event) => changes.push(event.target.value) }, options())));
	const form = view.container.querySelector("form");
	const trigger = view.container.querySelector("button[role=combobox]");
	await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
	const ready = Array.from(document.querySelectorAll('[role="option"]')).find((item) => item.textContent.includes("Ready"));
	assert.ok(ready, "the custom popup opens from the keyboard");
	assert.equal(Array.from(document.querySelectorAll('[role="option"]')).find((item) => item.textContent.includes("Blocked")).getAttribute("data-disabled"), "");
	await act(async () => { ready.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
	assert.deepEqual(changes, ["ready"]);
	assert.equal(new FormData(form).get("state"), "ready");
	await act(async () => { form.reset(); await Promise.resolve(); });
	assert.equal(new FormData(form).get("state"), "");
	assert.match(trigger.textContent, /Choose one/);
	await view.cleanup();
});

test("controlled selection is reflected in both visible and native controls", async () => {
	function Controlled() {
		const [value, setValue] = React.useState("");
		return h("form", null, h(CustomSelect, { name: "state", value, onChange: (event) => setValue(event.target.value), "aria-label": "State" }, options()));
	}
	const view = await mount(h(Controlled));
	const form = view.container.querySelector("form");
	const native = form.querySelector("select");
	await act(async () => { native.value = "ready"; native.dispatchEvent(new Event("change", { bubbles: true })); });
	assert.equal(new FormData(form).get("state"), "ready");
	assert.match(view.container.querySelector("button[role=combobox]").textContent, /Ready/);
	await view.cleanup();
});

test("implicit labels exclude option text and RTL reaches the visible control", async () => {
	document.documentElement.dir = "rtl";
	try {
		const view = await mount(h("label", null, "Language", h(CustomSelect, { defaultValue: "ready" }, options())));
		const trigger = view.container.querySelector("button[role=combobox]");
		assert.equal(trigger.getAttribute("aria-label"), "Language");
		assert.equal(trigger.getAttribute("dir"), "rtl");
		await view.cleanup();
	} finally {
		document.documentElement.removeAttribute("dir");
	}
});

test("an empty option remains selectable through the custom popup", async () => {
	const changes = [];
	const view = await mount(h("form", null, h(CustomSelect, { name: "state", defaultValue: "ready", required: true, "aria-label": "State", onChange: (event) => changes.push(event.target.value) }, options())));
	const trigger = view.container.querySelector("button[role=combobox]");
	await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
	const empty = Array.from(document.querySelectorAll('[role="option"]')).find((item) => item.textContent.includes("Choose one"));
	assert.ok(empty);
	await act(async () => { empty.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
	assert.deepEqual(changes, [""]);
	assert.equal(view.container.querySelector("select").checkValidity(), false);
	assert.equal(new FormData(view.container.querySelector("form")).get("state"), "");
	await view.cleanup();
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("hotkeys ignore missing keys and IME composition but retain normal key actions", async (t) => {
	const project = join(dirname(fileURLToPath(import.meta.url)), "..");
	const dir = mkdtempSync(join(project, "tests", ".tmp-hotkeys-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dom = new JSDOM("<!doctype html><div id='root'></div>");
	for (const key of ["window", "document", "HTMLElement", "Element"]) { globalThis[key] = dom.window[key]; t.after(() => delete globalThis[key]); }
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	t.after(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; dom.window.close(); });
	const outfile = join(dir, "hook.mjs");
	await build({ entryPoints: [join(project, "src/components/shortcuts/use-hotkeys.ts")], outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
	const { useHotkeys } = await import(pathToFileURL(outfile).href);
	const { createElement, act } = await import("react");
	const { createRoot } = await import("react-dom/client");
	let actions = 0;
	const errors = [];
	dom.window.addEventListener("error", (event) => { errors.push(event.error); event.preventDefault(); });
	function Fixture() { useHotkeys([{ key: "j", category: "Navigation", label: "Next", action: () => actions++ }]); return null; }
	const root = createRoot(document.getElementById("root"));
	await act(async () => root.render(createElement(Fixture)));
	await act(async () => { window.dispatchEvent(new dom.window.Event("keydown")); window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j", isComposing: true })); });
	assert.deepEqual(errors, []);
	assert.equal(actions, 0);
	await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j" })));
	assert.equal(actions, 1);
	await act(async () => root.unmount());
});

test("native Mac/Windows commands do not compose or navigate; app shortcuts still work", async (t) => {
	const project = join(dirname(fileURLToPath(import.meta.url)), "..");
	const dir = mkdtempSync(join(project, "tests", ".tmp-hotkeys-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dom = new JSDOM("<!doctype html><div id='root'></div><span id='copy'>Selected email address</span><input id='input'><button id='combobox' role='combobox'>Mailbox</button>");
	for (const key of ["window", "document", "HTMLElement", "Element"]) {
		globalThis[key] = dom.window[key]; t.after(() => delete globalThis[key]);
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	t.after(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; dom.window.close(); });
	const outfile = join(dir, "hook.mjs");
	await build({ entryPoints: [join(project, "src/components/shortcuts/use-hotkeys.ts")], outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
	const { useHotkeys } = await import(pathToFileURL(outfile).href);
	const { createElement, act } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const calls = [];
	function Fixture() {
		useHotkeys([
			{ key: "c", action: () => calls.push("compose") },
			{ key: "g i", action: () => calls.push("inbox") },
			{ key: "k", modifiers: ["meta", "ctrl"], action: () => calls.push("palette") },
			{ key: "/", action: () => calls.push("search") },
			{ key: "#", action: () => calls.push("trash") },
		]);
		useHotkeys([{ key: "c", action: () => calls.push("duplicate-compose") }]);
		return null;
	}
	const root = createRoot(document.getElementById("root"));
	await act(async () => root.render(createElement(Fixture)));
	const press = async (key, init = {}, target = window) => {
		const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
		await act(async () => target.dispatchEvent(event));
		return event.defaultPrevented;
	};
	for (const modifier of ["metaKey", "ctrlKey"]) {
		for (const key of ["c", "x", "v", "a", "z", "y", "r", "l", "w", "t", "/", "#"]) {
			assert.equal(await press(key, { [modifier]: true }), false, `${modifier}+${key} must reach the browser`);
		}
	}
	assert.deepEqual(calls, []);
	await press("g"); await press("i", { metaKey: true }); await press("i");
	assert.deepEqual(calls, []);
	assert.equal(await press("k"), false);
	assert.equal(await press("K", { metaKey: true, shiftKey: true }), false);
	assert.equal(await press("k", { metaKey: true, altKey: true }), false);
	await press("k", { metaKey: true });
	await press("g"); await press("i");
	await press("c"); await press("/");
	assert.deepEqual(calls, ["palette", "inbox", "compose", "search"]);
	const range = document.createRange(); range.selectNodeContents(document.getElementById("copy"));
	window.getSelection().addRange(range);
	assert.equal(await press("c", { metaKey: true }), false);
	assert.equal(await press("c"), false);
	assert.equal(window.getSelection().toString(), "Selected email address");
	assert.deepEqual(calls, ["palette", "inbox", "compose", "search"]);
	const combobox = document.getElementById("combobox");
	assert.equal(await press("c", {}, combobox), false, "combobox typeahead must not compose");
	await press("g", {}, combobox); await press("i", {}, combobox);
	assert.deepEqual(calls, ["palette", "inbox", "compose", "search"], "combobox typing must not activate sequences");
	assert.equal(await press("c", { metaKey: true }, combobox), false, "native commands must reach the browser from a combobox");
	window.getSelection().removeAllRanges();
	assert.equal(await press("c", { metaKey: true }, document.getElementById("input")), false);
	const handled = new dom.window.KeyboardEvent("keydown", { key: "c", cancelable: true });
	handled.preventDefault(); window.dispatchEvent(handled);
	assert.equal(calls.length, 4);
	await act(async () => root.unmount());
});

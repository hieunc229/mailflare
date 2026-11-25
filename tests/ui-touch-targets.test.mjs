import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { compile } from "@tailwindcss/node";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-ui-touch-targets-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { Button } from "./src/components/ui/button";
			import { Switch } from "./src/components/ui/switch";
			import { Checkbox } from "./src/components/ui/checkbox";
			export { createElement, Button, Switch, Checkbox };
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "ui.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	jsx: "automatic",
	logLevel: "silent",
});
const { createElement, Button, Switch, Checkbox } = await import(pathToFileURL(join(outDir, "ui.mjs")).href);
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function mount(element) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	await act(async () => createRoot(container).render(element));
	return container.firstElementChild;
}

const hit = (el) => el.className.split(/\s+/).filter((c) => c.startsWith("pointer-coarse:before:"));

test("Button and Switch get a coarse-pointer 44px hit area on every size", async () => {
	for (const size of ["default", "sm", "lg", "roundedSM", "icon"]) {
		const el = await mount(createElement(Button, { size }, "x"));
		assert.ok(hit(el).includes("pointer-coarse:before:min-h-11"), `button ${size}`);
		assert.ok(hit(el).includes("pointer-coarse:before:min-w-11"), `button ${size}`);
		assert.ok(el.classList.contains("relative"), `button ${size} anchors the hit area`);
		assert.ok(el.classList.contains("focus-visible:ring-2"), `button ${size} keeps its focus ring`);
	}
	const sw = await mount(createElement(Switch, { checked: false, onCheckedChange() {} }));
	assert.ok(hit(sw).includes("pointer-coarse:before:min-h-11"));
	assert.ok(sw.classList.contains("relative"));
	assert.ok(sw.classList.contains("focus-visible:ring-2"));
});

test("icon Button gets a real 44px box on coarse pointers so its hit area cannot spill", async () => {
	const el = await mount(createElement(Button, { size: "icon" }, "x"));
	assert.ok(el.classList.contains("pointer-coarse:size-11"));
	assert.ok(!el.classList.contains("h-8") && !el.classList.contains("h-4"), "no desktop box added");
});

test("dense rows add spacing on coarse pointers only", async () => {
	const { readFileSync } = await import("node:fs");
	const src = (f) => readFileSync(join(root, f), "utf8");
	assert.match(src("src/components/messages/conversation-notes.tsx"), /flex gap-0\.5 pointer-coarse:gap-2\.5/);
	assert.match(src("src/components/messages/message-list-row-actions.tsx"), /gap-0\.5 pointer-coarse:gap-2 /);
	assert.match(src("src/components/messages/message-folder-page.tsx"), /pointer-coarse:grid-cols-\[24px_minmax\(0,1fr\)\]/);
});

test("a caller can still position a Button", async () => {
	const el = await mount(createElement(Button, { className: "absolute right-4 top-4" }, "x"));
	assert.ok(el.classList.contains("absolute"));
	assert.ok(!el.classList.contains("relative"));
});

test("hit area does not change the desktop size", async () => {
	const el = await mount(createElement(Button, { size: "sm" }, "x"));
	assert.ok(el.classList.contains("h-8"));
	const cb = await mount(createElement(Checkbox, {}));
	assert.ok(cb.classList.contains("h-4") && cb.classList.contains("w-4"));
	assert.ok(cb.classList.contains("pointer-coarse:h-6") && cb.classList.contains("pointer-coarse:w-6"));
});

test("Tailwind emits the pointer-coarse variants inside a coarse media query", async () => {
	const compiler = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
	const css = compiler.build(["pointer-coarse:before:min-h-11", "pointer-coarse:h-6"]);
	assert.match(css, /@media \(pointer: coarse\)/);
	assert.match(css, /min-height/);
});

test("compose attach/remove buttons and takeout colour swatches use the shared hit area", async () => {
	const { readFileSync } = await import("node:fs");
	const compose = readFileSync(join(root, "src/components/compose/compose-form.tsx"), "utf8");
	assert.equal(compose.match(/touchTarget\)\}/g)?.length, 3, "paperclip plus two remove-attachment buttons");
	const takeout = readFileSync(join(root, "src/components/settings/takeout-calendar-card.tsx"), "utf8");
	assert.match(takeout, /clsx\(touchTarget, "relative h-7 w-7/);
	assert.match(takeout, /gap-1\.5 pointer-coarse:gap-2 /);
	const editor = readFileSync(join(root, "src/components/compose/rich-text-editor.tsx"), "utf8");
	assert.match(editor, /gap-0\.5 pointer-coarse:gap-2 /);
});

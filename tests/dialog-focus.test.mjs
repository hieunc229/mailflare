import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-dialog-focus-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/use-dialog-focus.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node24", packages: "external", logLevel: "silent",
});
const { isInsideOtherDialog } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

function setup() {
	const dom = new JSDOM(`<div id="editor" role="dialog"><button id="inner">x</button></div>
		<div id="confirm" role="alertdialog"><button id="cancel">Cancel</button></div><button id="page">p</button>`);
	globalThis.Element = dom.window.Element;
	const get = (id) => dom.window.document.getElementById(id);
	return { editor: get("editor"), inner: get("inner"), cancel: get("cancel"), page: get("page") };
}

test("a portaled confirm dialog keeps its own Tab handling", () => {
	const { editor, cancel } = setup();
	assert.equal(isInsideOtherDialog(editor, cancel), true);
});

test("focus inside the editor, or loose on the page, is still trapped", () => {
	const { editor, inner, page } = setup();
	assert.equal(isInsideOtherDialog(editor, inner), false);
	assert.equal(isInsideOtherDialog(editor, page), false);
	assert.equal(isInsideOtherDialog(editor, null), false);
});

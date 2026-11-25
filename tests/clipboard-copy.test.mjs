import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "mailflare-clipboard-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/clipboard.ts")], outfile: join(directory, "clipboard.mjs"), bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const { copyText } = await import(pathToFileURL(join(directory, "clipboard.mjs")).href);

function fakeDom(execResult) {
	const appended = [];
	const copied = [];
	const focused = [];
	globalThis.document = {
		activeElement: { focus: (options) => focused.push(options) },
		createElement: () => ({ style: {}, setAttribute() {}, select() { this.selected = true; }, setSelectionRange() {} }),
		body: { appendChild: (node) => appended.push(node), removeChild: (node) => appended.splice(appended.indexOf(node), 1) },
		execCommand: (command) => { assert.equal(command, "copy"); copied.push(appended[0]?.value); return execResult; },
	};
	return { appended, copied, focused };
}
function setClipboard(value) {
	Object.defineProperty(globalThis, "navigator", { value, configurable: true });
}
afterEach(() => { delete globalThis.document; setClipboard({}); });

test("uses the async clipboard API when it exists", async () => {
	const written = [];
	setClipboard({ clipboard: { writeText: async (text) => { written.push(text); } } });
	assert.equal(await copyText("secret"), true);
	assert.deepEqual(written, ["secret"]);
});

test("falls back to a selected text field on plain http, where navigator.clipboard is undefined", async () => {
	setClipboard({});
	const dom = fakeDom(true);
	assert.equal(await copyText("secret"), true);
	assert.deepEqual(dom.copied, ["secret"]);
	assert.equal(dom.appended.length, 0, "temporary field is removed");
	assert.deepEqual(dom.focused, [{ preventScroll: true }], "focus returns to the element that had it (the Copy button)");
});

test("falls back when the async clipboard API rejects", async () => {
	setClipboard({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
	const dom = fakeDom(true);
	assert.equal(await copyText("secret"), true);
	assert.deepEqual(dom.copied, ["secret"]);
});

test("reports failure instead of throwing when nothing can copy", async () => {
	setClipboard({});
	const dom = fakeDom(false);
	assert.equal(await copyText("secret"), false);
	assert.equal(dom.appended.length, 0);
});

test("the app-password Field wraps the value, makes it selectable and reports a failed copy", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(join(root, "src/components/settings/app-passwords-settings.tsx"), "utf8");
	assert.doesNotMatch(source, /min-w-0 flex-1 truncate/);
	assert.match(source, /break-all select-all/);
	assert.match(source, /copyText\(/);
	assert.match(source, /t\("source\.couldNotCopy"\)/);
	assert.doesNotMatch(source, /navigator\.clipboard/);
});

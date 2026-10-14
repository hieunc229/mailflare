import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-hotkeys-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { findSequenceMatch, isModifierKey } from "./src/components/shortcuts/use-hotkeys-utils.ts";`,
		resolveDir: root,
		sourcefile: "hotkey-sequences-entry.ts",
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
const { findSequenceMatch, isModifierKey } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const shortcuts = [{ key: "g i" }, { key: "g !" }, { key: "e" }];

test("a sequence matches when it ends the buffer", () => {
	assert.equal(findSequenceMatch(["g", "i"], shortcuts), shortcuts[0]);
	assert.equal(findSequenceMatch(["j", "g", "i"], shortcuts), shortcuts[0]);
	assert.equal(findSequenceMatch(["g", "!"], shortcuts), shortcuts[1]);
});

test("single keys are left to the modifier-aware shortcut handler", () => {
	assert.equal(findSequenceMatch(["e"], shortcuts), undefined);
	assert.equal(findSequenceMatch(["j", "e"], shortcuts), undefined);
	assert.equal(findSequenceMatch([], shortcuts), undefined);
});

test("modifier keys are not part of a sequence", () => {
	for (const key of ["shift", "control", "alt", "meta"]) assert.equal(isModifierKey(key), true);
	assert.equal(isModifierKey("g"), false);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempDirectory = mkdtempSync(join(root, "node_modules", "mailflare-button-ring-test-"));

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			import { Button } from "./src/components/ui/button.tsx";
			export const render = (props) => renderToStaticMarkup(createElement(Button, props, "Save"));
		`,
		resolveDir: root,
		sourcefile: "button-ring-entry.tsx",
		loader: "tsx",
	},
	outfile: join(tempDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});

const { render } = await import(pathToFileURL(join(tempDirectory, "entry.mjs")).href);
rmSync(tempDirectory, { recursive: true, force: true });

test("default and destructive buttons set an explicit focus ring colour", () => {
	assert.match(render({}), /focus-visible:ring-blue-600/);
	const destructive = render({ variant: "destructive" });
	assert.match(destructive, /focus-visible:ring-red-600/);
	assert.doesNotMatch(destructive, /focus-visible:ring-blue-600/);
	assert.match(render({ variant: "outline" }), /focus-visible:ring-2/);
});

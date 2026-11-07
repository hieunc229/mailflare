import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "avatar-preview-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	entryPoints: [join(project, "src/components/progressive-avatar-image.tsx")],
	outfile: join(directory, "avatar.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	jsx: "automatic",
	logLevel: "silent",
});

const { ProgressiveAvatarImage } = await import(pathToFileURL(join(directory, "avatar.mjs")).href);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
	dom.window.close();
	delete globalThis.window;
	delete globalThis.document;
	delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function render(props) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(createElement(ProgressiveAvatarImage, props)));
	return {
		src: () => container.querySelector("img")?.getAttribute("src"),
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

test("small avatars skip the blurred preview request", async () => {
	const view = await render({ src: "/api/profile/avatar", alt: "", skipPreview: true });
	assert.equal(view.src(), "/api/profile/avatar");
	await view.unmount();
});

test("large avatars keep loading the preview first", async () => {
	const view = await render({ src: "/api/profile/avatar", alt: "" });
	assert.equal(view.src(), "/api/profile/avatar?variant=preview");
	await view.unmount();
});

test("a versioned avatar keeps its query when the preview is skipped", async () => {
	const view = await render({ src: "/api/profile/avatar?v=42", alt: "", skipPreview: true });
	assert.equal(view.src(), "/api/profile/avatar?v=42");
	await view.unmount();
});

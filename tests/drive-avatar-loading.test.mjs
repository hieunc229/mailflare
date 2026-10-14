import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

import { createsDriveItemInCurrentListing, newDriveItemParent } from "../src/app/(drive)/drive-destination.ts";

test("new items from virtual and read-only views target My Drive", () => {
	assert.equal(newDriveItemParent("attachments", false, null), null);
	assert.equal(newDriveItemParent("attachments", true, "drive-folder"), null);
	assert.equal(newDriveItemParent("trash", false, null), null);
	assert.equal(newDriveItemParent("shared", true, "shared-folder"), "shared-folder");
	assert.equal(newDriveItemParent("my", false, "read-only-folder"), null);
	assert.equal(newDriveItemParent("my", true, "my-folder"), "my-folder");
	assert.equal(createsDriveItemInCurrentListing("shared", true, "shared-folder"), true);
	assert.equal(createsDriveItemInCurrentListing("shared", true, null), false);
	assert.equal(createsDriveItemInCurrentListing("attachments", true, "drive-folder"), false);
});

test("avatar keeps its blurred preview effect while full image loads in parallel", async (t) => {
	const directory = mkdtempSync(join(process.cwd(), "node_modules", "mailflare-avatar-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	await build({
		entryPoints: ["src/components/progressive-avatar-image.tsx"],
		outfile: join(directory, "avatar.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "silent",
	});
	const { JSDOM } = await import("jsdom");
	const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
	for (const key of ["window", "document", "navigator", "HTMLElement"]) {
		Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
		t.after(() => { delete globalThis[key]; });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	t.after(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; dom.window.close(); });
	const requests = [];
	class PreloadImage {
		set src(value) { this.url = value; requests.push(this); }
	}
	globalThis.Image = PreloadImage;
	t.after(() => { delete globalThis.Image; });
	const React = await import("react");
	const { act } = React;
	const { createRoot } = await import("react-dom/client");
	const { ProgressiveAvatarImage } = await import(pathToFileURL(join(directory, "avatar.mjs")).href);
	const root = createRoot(dom.window.document.getElementById("root"));
	const src = "/api/profile/avatar?v=avatar-test";
	await act(async () => root.render(React.createElement(ProgressiveAvatarImage, { src, alt: "Avatar" })));
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, src);
	assert.equal(dom.window.document.querySelector("img").getAttribute("src"), `${src}&variant=preview`);
	assert.equal(dom.window.document.querySelector("img").style.filter, "blur(4px)");
	await act(async () => requests[0].onload());
	assert.equal(dom.window.document.querySelector("img").getAttribute("src"), src);
	assert.equal(dom.window.document.querySelector("img").style.filter, "");
	await act(async () => root.render(null));
	await act(async () => root.render(React.createElement(ProgressiveAvatarImage, { src, alt: "Avatar" })));
	assert.equal(requests.length, 1, "a remount should reuse the ready full image");
	assert.equal(dom.window.document.querySelector("img").getAttribute("src"), src);
	await act(async () => root.unmount());
});

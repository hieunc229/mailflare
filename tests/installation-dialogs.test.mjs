import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(project, "tests", ".tmp-installation-dialogs-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "NodeFilter", "KeyboardEvent", "MouseEvent", "FocusEvent"]) globalThis[name] = dom.window[name];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const outfile = join(tmp, "dialogs.mjs");
await build({ stdin: { contents: `import React, {act} from 'react'; import {createRoot} from 'react-dom/client'; export {React,act,createRoot}; export * from './src/components/ui/installation-dialogs';`, resolveDir: project, loader: "tsx" }, outfile, bundle: true, platform: "browser", format: "esm", target: "es2022", external: ["react", "react-dom", "react-dom/client"], alias: { "@": join(project, "src") }, logLevel: "silent" });
const { React, act, createRoot, InstallationDialogs, confirmAction, promptAction } = await import(pathToFileURL(outfile).href);

test("missing dialog host denies destructive confirmations", async () => {
	assert.equal(await confirmAction("Delete?"), false);
	assert.equal(await promptAction("Type domain"), null);
});

test("custom confirmation cancellation, confirmation, and typed prompt retain their results", async () => {
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(React.createElement(InstallationDialogs)));
	let answer;
	await act(async () => { answer = confirmAction("Delete this message?"); });
	assert.ok(document.querySelector('[role="dialog"]'));
	await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Cancel").click());
	assert.equal(await answer, false);
	await act(async () => { answer = confirmAction("Delete this message?"); });
	await act(async () => document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
	assert.equal(await answer, true);
	await act(async () => { answer = promptAction("Type example.com to confirm."); });
	const input = document.querySelector("input");
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "example.com");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
	assert.equal(await answer, "example.com");
	await act(async () => root.unmount()); container.remove();
});

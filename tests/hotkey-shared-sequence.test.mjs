import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { useHotkeys } = await loadComponent("src/components/shortcuts/use-hotkeys.ts");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

// Mirrors the app: a page-level hook (MessageActions, "!" = report spam) mounted
// next to the provider hook ("g !" = go to Spam). The page hook registers first.
function Page({ log }) {
	useHotkeys([{ key: "!", label: "spam", category: "Message", action: () => log.push("report-spam") }]);
	return null;
}
function Provider({ log }) {
	useHotkeys([{ key: "g !", label: "go spam", category: "Navigation", action: () => log.push("go-spam") }]);
	return null;
}
function press(key) {
	document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

test("g then ! goes to Spam without also reporting the open message as spam", async (t) => {
	const log = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement("div", {}, createElement(Page, { log }), createElement(Provider, { log }))); });

	press("g");
	press("!");
	assert.deepEqual(log, ["go-spam"]);

	log.length = 0;
	press("!");
	assert.deepEqual(log, ["report-spam"], "a lone ! still reports spam");
});

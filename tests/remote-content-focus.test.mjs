import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { EmailHtmlRenderer } = await loadComponent("src/components/messages/email-html-renderer.tsx", {
	"@/components/language-provider": "export function useLanguage() { return { t: (key) => key }; }",
});

test("allowing remote content keeps focus inside the message", async (t) => {
	globalThis.MutationObserver ??= class { observe() {} disconnect() {} };
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	let allowed = 0;
	await act(async () => { root.render(createElement(EmailHtmlRenderer, { html: '<p>hi</p><img src="https://example.com/a.png">', onAllowRemote: () => { allowed += 1; } })); });
	const button = container.querySelector("button");
	assert.ok(button, "the allow button shows for remote content");
	assert.equal(button.getAttribute("aria-pressed"), null);
	await act(async () => { button.focus(); button.click(); });
	assert.equal(allowed, 1);
	assert.equal(container.querySelector("button"), null);
	assert.ok(container.contains(document.activeElement) && document.activeElement !== document.body, "focus stays in the renderer");
});

test("the template delete control is a menu item, not a nested button", () => {
	const source = readFileSync(new URL("../src/components/compose/template-menu.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(source, /<button/);
	assert.doesNotMatch(source, /opacity-0/);
	assert.match(source, /<DropdownMenu\.Item\s+aria-label=\{t\("template\.delete"\)\}/);
});

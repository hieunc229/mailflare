import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadComponent } from "./helpers/dom-component.mjs";

// React DOM feature-detects the `input` event at import time, so the DOM must exist first.
installDom();

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { TimeZoneForm } = await loadComponent("src/components/settings/time-zone-form.tsx", {
	"@/components/language-provider": "const t = (key) => key; export function useLanguage() { return { t }; }",
	"@/components/ui/button": `import React from "react"; export function Button({children, variant, size, ...p}) { return React.createElement("button", p, children); }`,
	"@/components/ui/input": `import React from "react"; export function Input({containerClassName, ...p}) { return React.createElement("input", p); }`,
	"@/components/ui/label": `import React from "react"; export function Label({children, ...p}) { return React.createElement("label", p, children); }`,
	"@/lib/time/client": "export function saveUserTimeZonePreference() {}",
	"./time-zone-form-utils": `
export function listTimeZones() { globalThis.__listCalls++; return ["UTC", "Asia/Tokyo"]; }
export function formatCurrentTimeInZone(zone) { if (zone === "Nope/Zone") throw new RangeError("bad"); return "noon"; }
export async function updateUserTimeZone(v) { return v; }`,
});

async function mount(t) {
	globalThis.__listCalls = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(TimeZoneForm, { userId: "u", initialTimeZone: "" })); });
	return container;
}

const type = (container, value) => act(async () => {
	const input = container.querySelector("input");
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
	input.dispatchEvent(new window.Event("input", { bubbles: true }));
});

test("an invalid zone marks the input invalid", async (t) => {
	const c = await mount(t);
	assert.notEqual(c.querySelector("input").getAttribute("aria-invalid"), "true");
	await type(c, "Nope/Zone");
	assert.equal(c.querySelector("input").getAttribute("aria-invalid"), "true");
	await type(c, "Asia/Tokyo");
	assert.notEqual(c.querySelector("input").getAttribute("aria-invalid"), "true");
});

test("the zone list is not rebuilt on every keystroke", async (t) => {
	const c = await mount(t);
	await type(c, "A");
	await type(c, "As");
	assert.equal(globalThis.__listCalls, 1);
});

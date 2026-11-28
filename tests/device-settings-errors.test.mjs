import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { DeviceSettings } = await loadComponent("src/components/settings/device-settings.tsx", {
	"@/components/ui/confirm-dialog": "export async function confirmDestructive() { return true; }",
	"@/components/icons": "export const Bell = () => null, Smartphone = () => null;",
	"@/components/language-provider": "const t = (key) => key; export function useLanguage() { return { t }; }",
	"@/components/ui/button": `import React from "react"; export function Button({children, variant, size, ...p}) { return React.createElement("button", p, children); }`,
	"@/lib/time/utils": "export const formatUserDate = (d) => String(d);",
	"./device-settings-utils": `
export async function loadDevices() { return [{ id: "d1", name: "Phone", pushEnabled: false, createdAt: "2026-01-01", lastUsedAt: null }]; }
export async function signOutDevice() { const next = globalThis.__signOut.shift(); if (next instanceof Error) throw next; }`,
});

test("a failed sign-out shows its own message, announced, and a later success clears it", async (t) => {
	globalThis.__signOut = [new Error("Could not sign out"), undefined];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(DeviceSettings)); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	const signOut = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "devices.signOut");
	await act(async () => { signOut().click(); await new Promise((r) => setTimeout(r, 0)); });
	const alert = container.querySelector('[role="alert"]');
	assert.ok(alert, "error has role=alert");
	assert.equal(alert.textContent, "Could not sign out");
	assert.ok(!alert.textContent.includes("devices.loadFailed"));
	await act(async () => { signOut().click(); await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(container.querySelector('[role="alert"]'), null, "cleared after a later success");
});

test("a failed load shows the load message", async (t) => {
	const mod = await loadComponent("src/components/settings/device-settings.tsx", {
		"@/components/ui/confirm-dialog": "export async function confirmDestructive() { return true; }",
		"@/components/icons": "export const Bell = () => null, Smartphone = () => null;",
		"@/components/language-provider": "const t = (key) => key; export function useLanguage() { return { t }; }",
		"@/components/ui/button": `import React from "react"; export function Button({children, ...p}) { return React.createElement("button", p, children); }`,
		"@/lib/time/utils": "export const formatUserDate = (d) => String(d);",
		"./device-settings-utils": `export async function loadDevices() { throw "x"; } export async function signOutDevice() {}`,
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(mod.DeviceSettings)); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(container.querySelector('[role="alert"]')?.textContent, "devices.loadFailed");
});

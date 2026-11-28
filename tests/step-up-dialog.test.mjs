import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const ui = `
import React from "react";
export function Button({children, variant, size, ...p}) { return React.createElement("button", p, children); }
export function Input({containerClassName, ...p}) { return React.createElement("input", p); }
export function Label({children, ...p}) { return React.createElement("label", p, children); }
const box = ({children}) => React.createElement("div", {}, children);
export const DialogContent = box, DialogHeader = box, DialogTitle = box, DialogDescription = box;
export function Dialog({open, onOpenChange, children}) { return open ? React.createElement("div", {}, children, React.createElement("button", {"data-testid": "dismiss", onClick: () => onOpenChange(false)})) : null; }
`;

const { StepUpDialog } = await loadComponent("src/components/settings/step-up-dialog.tsx", {
	"@/components/icons": "export const KeyRound = () => null, ShieldCheck = () => null;",
	"@/components/language-provider": "export function useLanguage() { return { t: (key) => key }; }",
	"@/components/ui/button": ui,
	"@/components/ui/dialog": ui,
	"@/components/ui/input": ui,
	"@/components/ui/label": ui,
	"./passkey-settings-utils": "export async function stepUpWithPasskey() { return globalThis.__passkey(); } export async function stepUpWithPassword() { return 'tok'; }",
});

async function mount(t) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	globalThis.__authorized = [];
	globalThis.__openChanges = [];
	const render = (open) => act(async () => {
		root.render(createElement(StepUpDialog, {
			open, hasPassword: false, hasPasskey: true, action: "x",
			onOpenChange: (next) => globalThis.__openChanges.push(next),
			onAuthorized: (token) => { globalThis.__authorized.push(token); },
		}));
	});
	await render(true);
	return { container, render };
}

const pending = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("no action runs after the dialog was closed during the passkey prompt", async (t) => {
	const { container, render } = await mount(t);
	const gate = pending();
	globalThis.__passkey = () => gate.promise;
	await act(async () => { container.querySelector("button").click(); });
	await render(false);
	await act(async () => { gate.resolve("token"); await gate.promise; });
	assert.deepEqual(globalThis.__authorized, []);
});

test("dismissing is ignored while the passkey prompt is busy", async (t) => {
	const { container } = await mount(t);
	const gate = pending();
	globalThis.__passkey = () => gate.promise;
	await act(async () => { container.querySelector("button").click(); });
	await act(async () => { container.querySelector('[data-testid="dismiss"]').click(); });
	assert.deepEqual(globalThis.__openChanges, []);
	await act(async () => { gate.resolve("token"); await gate.promise; });
	assert.deepEqual(globalThis.__authorized, ["token"]);
	assert.deepEqual(globalThis.__openChanges, [false], "closes itself after success");
});

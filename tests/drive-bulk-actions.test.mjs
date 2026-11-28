import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const icon = `import React from "react"; const I = () => React.createElement("i");
export const Folder = I, FolderInput = I, FolderPlus = I, HardDrive = I, RotateCcw = I, Trash2 = I, X = I;`;
const button = `import React from "react"; export function Button({ children, size, variant, ...p }) { return React.createElement("button", p, children); }`;
const { DriveBulkActions } = await loadComponent("src/app/(drive)/drive-bulk-actions.tsx", {
	"@/components/icons": icon,
	"@/components/language-provider": `export function useLanguage() { return { t: (key) => key }; }`,
	"@/components/ui/button": button,
	"@/components/ui/confirm-dialog": `export async function confirmDestructive() { return true; }`,
	"react-hot-toast": `export default { success: (m) => globalThis.__toasts.push(["ok", m]), error: (m) => globalThis.__toasts.push(["err", m]) };`,
	"@/lib/auth/client": `export async function authFetch(url) { return globalThis.__respond(url); }`,
});

const drive = { id: "d1", kind: "file", role: "owner", name: "a", size: 1 };
const attachment = { ...drive, id: "a1", source: { messageId: "m", subject: "s", direction: "inbound", canDelete: true } };
const ok = () => Response.json({ count: 1 });
const fail = () => Response.json({ error: "no" }, { status: 500 });

async function run(t, driveAnswer, attachmentAnswer) {
	globalThis.__toasts = [];
	globalThis.__respond = (url) => (url === "/api/drive/items/bulk" ? driveAnswer() : attachmentAnswer());
	let done = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(DriveBulkActions, { selected: [drive, attachment], trashView: false, onDone: () => { done += 1; } })); });
	const trash = [...container.querySelectorAll("button")].find((b) => b.textContent === "drive.moveToTrash");
	await act(async () => { trash.click(); });
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
	return { done, toasts: globalThis.__toasts };
}

test("refreshes after the Drive part succeeds and the attachment part fails", async (t) => {
	const result = await run(t, ok, fail);
	assert.equal(result.done, 1);
	assert.ok(result.toasts.some(([kind, text]) => kind === "err" && text === "no"));
	assert.ok(result.toasts.some(([kind]) => kind === "ok"));
});

test("refreshes after the attachment part succeeds and the Drive part fails", async (t) => {
	assert.equal((await run(t, fail, ok)).done, 1);
});

test("keeps the selection when both parts fail", async (t) => {
	assert.equal((await run(t, fail, fail)).done, 0);
});

test("refreshes when both succeed", async (t) => {
	const result = await run(t, ok, ok);
	assert.equal(result.done, 1);
	assert.equal(result.toasts.filter(([kind]) => kind === "ok").length, 1);
});

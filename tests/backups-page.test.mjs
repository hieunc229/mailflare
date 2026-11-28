import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const stubs = {
	"@/components/language-provider": `export function useLanguage() { return { t: (key, p) => key }; }`,
	"@/components/ui/dialog": `
import React from "react";
export function Dialog({open, onOpenChange, children}) { return open ? React.createElement("div", {}, children, React.createElement("button", {"data-testid": "dialog-close", onClick: () => onOpenChange(false)})) : null; }
const box = ({children}) => React.createElement("div", {}, children);
export const DialogContent = box, DialogHeader = box, DialogTitle = box, DialogDescription = box;`,
	"@radix-ui/react-dropdown-menu": `
import React from "react";
const box = ({children}) => React.createElement("div", {}, children);
export const Root = box, Trigger = box, Portal = box, Content = box;
export function Item({children, onSelect, disabled}) { return React.createElement("button", {disabled, onClick: () => onSelect?.()}, children); }`,
	"@/components/ui/confirm-dialog": `export async function confirmDestructive(message) { globalThis.confirmCalls.push(message); return globalThis.confirmAnswer; }`,
	"@/components/ui/select": `
import React from "react";
export function Select({children, containerClassName, ...p}) { return React.createElement("select", p, children); }`,
	"./utils": `
export const WEEKDAYS = [];
export async function fetchBackups() { return globalThis.backupsResponse; }
export async function saveBackupSettings(s) { globalThis.savedSettings.push(s); }
export async function removeBackup(id) { globalThis.removedIds.push(id); }
export async function downloadBackup() {}
export async function restoreBackup() {}
export async function startBackup() {}
export const formatBackupDate = (d) => String(d);
export const formatBackupSize = (n) => String(n);
export const getStatusClass = () => "";`,
};

const { default: BackupsPage } = await loadComponent("src/app/(admin)/backups/page.tsx", stubs);

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(t, backups = []) {
	globalThis.confirmCalls = [];
	globalThis.confirmAnswer = true;
	globalThis.savedSettings = [];
	globalThis.removedIds = [];
	globalThis.backupsResponse = {
		backups,
		settings: { enabled: false, scheduleType: "daily", scheduleValue: null, retentionEnabled: false, retentionDays: 30, excludedTableGroups: [] },
		configuration: { configured: true, missing: [] },
	};
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(BackupsPage))); });
	await settle();
	return container;
}

const click = (el) => act(async () => { el.click(); });
const buttonByText = (container, text) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);
const groupSwitch = (container) => container.querySelector('[aria-label="backups.backUpGroup"]');

test("closing the settings dialog without saving discards its edits", async (t) => {
	const c = await mount(t);
	await click(buttonByText(c, "backups.settings"));
	await click(groupSwitch(c));
	await click(c.querySelector('[data-testid="dialog-close"]'));
	await click(c.querySelector("#automatic-backup-switch"));
	await settle();
	assert.equal(globalThis.savedSettings.length, 1);
	assert.deepEqual(globalThis.savedSettings[0].excludedTableGroups, []);
	assert.equal(globalThis.savedSettings[0].enabled, true);
});

test("reopening the dialog shows saved state, not the abandoned edit", async (t) => {
	const c = await mount(t);
	await click(buttonByText(c, "backups.settings"));
	await click(groupSwitch(c));
	await click(c.querySelector('[data-testid="dialog-close"]'));
	await click(buttonByText(c, "backups.settings"));
	assert.equal(groupSwitch(c).getAttribute("aria-checked"), "true");
});

test("Save in the dialog persists the draft", async (t) => {
	const c = await mount(t);
	await click(buttonByText(c, "backups.settings"));
	await click(groupSwitch(c));
	await click(buttonByText(c, "backups.saveSettings"));
	await settle();
	assert.equal(globalThis.savedSettings.length, 1);
	assert.deepEqual(globalThis.savedSettings[0].excludedTableGroups, ["accounts"]);
});

const ONE = { id: "b1", filename: "mailflare-1.json", status: "completed", size: 10, createdAt: "2026-01-01", trigger: "manual", error: null };
const deleteButton = (c) => c.querySelector('button[title="backups.delete"]');

test("delete asks for confirmation naming the file and does nothing when cancelled", async (t) => {
	const c = await mount(t, [ONE]);
	globalThis.confirmAnswer = false;
	await click(deleteButton(c));
	await settle();
	assert.equal(globalThis.confirmCalls.length, 1);
	assert.ok(globalThis.confirmCalls[0].includes("mailflare-1.json"));
	assert.deepEqual(globalThis.removedIds, []);
});

test("delete runs after the admin confirms", async (t) => {
	const c = await mount(t, [ONE]);
	globalThis.confirmAnswer = true;
	await click(deleteButton(c));
	await settle();
	assert.deepEqual(globalThis.removedIds, ["b1"]);
});

test("a backup without a filename is confirmed by id", async (t) => {
	const c = await mount(t, [{ ...ONE, filename: null }]);
	await click(deleteButton(c));
	await settle();
	assert.ok(globalThis.confirmCalls[0].includes("b1"));
});

test("history is a table in a scrollable labelled region", async (t) => {
	const c = await mount(t, [ONE]);
	const region = c.querySelector('[role="region"][aria-label="backups.history"]');
	assert.ok(region, "labelled region");
	assert.ok(region.className.includes("overflow-x-auto"));
	const table = region.querySelector("table");
	assert.ok(table, "table");
	assert.equal(table.querySelectorAll('th[scope="col"]').length, 5);
	assert.deepEqual([...table.querySelectorAll("th")].map((th) => th.textContent),
		["backups.col.file", "backups.col.status", "backups.col.size", "backups.col.created", "backups.col.actions"]);
	assert.equal(table.querySelectorAll("tbody tr").length, 1);
});

test("icon buttons are named after the file", async (t) => {
	const c = await mount(t, [ONE]);
	assert.ok(c.querySelector('button[aria-label="backups.download: mailflare-1.json"]'));
	assert.ok(c.querySelector('button[aria-label="backups.delete: mailflare-1.json"]'));
});

test("empty history shows the none message", async (t) => {
	const c = await mount(t, []);
	assert.ok(c.textContent.includes("backups.none"));
});

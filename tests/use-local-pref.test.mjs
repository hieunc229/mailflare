import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const latest = await loadComponent("src/components/messages/use-latest-messages-first.ts");
const advance = await loadComponent("src/components/messages/use-auto-advance.ts");
const twoColumn = await loadComponent("src/components/messages/use-two-column-reading.ts");

const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };

async function renders(t, hook) {
	const seen = [];
	let setter;
	function Probe() { const [value, update] = hook(); seen.push(value); setter = update; return null; }
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(Probe)); });
	return { seen, update: (next) => act(async () => setter(next)) };
}

test("preferences render their stored value on the first render", async (t) => {
	storage.set("mailflare-latest-messages-first", "off");
	storage.set("mailflare-auto-advance", "on");
	storage.set("mailflare-two-column-reading", "off");
	assert.equal((await renders(t, latest.useLatestMessagesFirst)).seen[0], false);
	assert.equal((await renders(t, advance.useAutoAdvanceEnabled)).seen[0], true);
	assert.equal((await renders(t, twoColumn.useTwoColumnReading)).seen[0], false);
});

test("an update is stored and reaches every mounted user", async (t) => {
	storage.clear();
	const first = await renders(t, latest.useLatestMessagesFirst);
	const second = await renders(t, latest.useLatestMessagesFirst);
	assert.equal(first.seen.at(-1), true);
	await first.update(false);
	assert.equal(storage.get("mailflare-latest-messages-first"), "off");
	assert.equal(second.seen.at(-1), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { useProviderAction } = await loadComponent("src/app/(admin)/domains/use-provider-action.ts", {
	"@/components/language-provider": "export function useLanguage(){ return { t: (key) => globalThis.__lang + ':' + key }; }",
});

const capture = (api) => { globalThis.__api = api; };

function Probe() {
	capture(useProviderAction());
	return null;
}

async function mount(t) {
	globalThis.__lang = "en";
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	const render = (tick) => act(async () => { root.render(createElement(Probe, { tick })); });
	await render(0);
	return render;
}

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("run marks busy and clears it afterwards", async (t) => {
	await mount(t);
	const gate = deferred();
	let pending;
	await act(async () => { pending = globalThis.__api.run("verify", () => gate.promise); });
	assert.equal(globalThis.__api.busy, "verify");
	await act(async () => { gate.resolve(); await pending; });
	assert.equal(globalThis.__api.busy, null);
});

test("run clears an earlier error and notice first", async (t) => {
	await mount(t);
	await act(async () => { globalThis.__api.setError("old"); globalThis.__api.setNotice("note"); });
	assert.equal(globalThis.__api.error, "old");
	const gate = deferred();
	let pending;
	await act(async () => { pending = globalThis.__api.run("setup", () => gate.promise); });
	assert.equal(globalThis.__api.error, "");
	assert.equal(globalThis.__api.notice, "");
	await act(async () => { gate.resolve(); await pending; });
});

test("an Error rejection shows its message", async (t) => {
	await mount(t);
	await act(async () => { await globalThis.__api.run("test", async () => { throw new Error("boom"); }); });
	assert.equal(globalThis.__api.error, "boom");
});

test("a non-Error rejection uses the current language", async (t) => {
	const render = await mount(t);
	const first = globalThis.__api.run;
	globalThis.__lang = "fr";
	await render(1);
	assert.notEqual(globalThis.__api.run, first);
	await act(async () => { await globalThis.__api.run("test", () => Promise.reject("x")); });
	assert.equal(globalThis.__api.error, "fr:domains.requestFailed");
});

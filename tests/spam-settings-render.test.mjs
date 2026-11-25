import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-spam-render-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const stubs = new Map([
	["@/components/language-provider", `export function useLanguage() { return { t: (key) => key }; }`],
	["@/lib/auth/client", `export function authFetch(...args) { return globalThis.__spamFetch(...args); }`],
]);
await build({
	entryPoints: [join(root, "src/components/settings/spam-filter-settings.tsx")],
	outfile: join(temp, "spam.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	packages: "external",
	external: ["react", "react-dom", "react-dom/*"],
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "spam-stubs",
		setup(b) {
			b.onResolve({ filter: /.*/ }, (args) => stubs.has(args.path) ? { path: args.path, namespace: "spam-stub" } : undefined);
			b.onLoad({ filter: /.*/, namespace: "spam-stub" }, (args) => ({ contents: stubs.get(args.path), loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SpamFilterSettings } = await import(pathToFileURL(join(temp, "spam.mjs")).href);

async function mount(t) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	t.after(async () => { await act(async () => reactRoot.unmount()); container.remove(); });
	await act(async () => { reactRoot.render(createElement(SpamFilterSettings)); });
	return container;
}
const response = (data, status = 200) => ({ ok: status < 400, status, async json() { return data; } });

test("while loading, placeholders show no switch, no radios and no 'on / strict' state", async (t) => {
	globalThis.__spamFetch = () => new Promise(() => {});
	const container = await mount(t);
	assert.equal(container.querySelector('[role="switch"]'), null);
	assert.equal(container.querySelector('input[type="radio"]'), null);
	assert.ok(container.querySelector('[aria-hidden="true"].animate-pulse'), "Skeleton placeholders render");
	assert.equal(container.firstElementChild.getAttribute("aria-busy"), "true");
});

test("after a failed load: skeletons, translated alert with Retry, and Retry restores real controls", async (t) => {
	let fail = true;
	globalThis.__spamFetch = async () => fail ? response({ error: "boom internal" }, 500) : response({ enabled: false, strictness: "relaxed" });
	const container = await mount(t);
	assert.equal(container.querySelector('[role="switch"]'), null, "no switch claiming a value after failure");
	assert.equal(container.querySelector('input[type="radio"]'), null);
	assert.ok(container.querySelector(".animate-pulse"));
	const alert = container.querySelector('[role="alert"]');
	assert.equal(alert.querySelector("p").textContent, "settings.spam.loadFailed");
	assert.doesNotMatch(container.textContent, /boom internal/);

	fail = false;
	await act(async () => { alert.querySelector("button").click(); });
	assert.equal(container.querySelector('[role="alert"]'), null);
	assert.equal(container.querySelector(".animate-pulse"), null);
	assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "false", "real value, not the placeholder default");
	assert.equal(container.querySelector('input[type="radio"]:checked').nextElementSibling.textContent, "settings.spam.strictness.relaxed");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { loadFixture } from "./helpers/fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node", clipboard: { writeText: async (value) => { if (globalThis.pubUiR.clipboardFails) throw new Error("denied"); globalThis.pubUiR.copied.push(value); } } }, configurable: true });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.pubUiR = { en, respond: null, calls: [], confirm: true, confirms: [], toasts: [], copied: [], clipboardFails: false };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.pubUiR.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/auth/client": "export async function authFetch(url,init){const s=globalThis.pubUiR;s.calls.push([url,init?.method??'GET']);return s.respond(url,init)}",
	"@/components/ui/confirm-dialog": "export async function confirmDestructive(options){const s=globalThis.pubUiR;s.confirms.push(options);return s.confirm}",
	"react-hot-toast": "export default {success:(m)=>globalThis.pubUiR.toasts.push(['ok',m]),error:(m)=>globalThis.pubUiR.toasts.push(['error',m])}",
};
const fixture = await loadFixture({ name: "pub-ui-review", entryPoint: "src/app/(calendar)/calendar/publish-card.tsx", mocks });
const { PublishCard } = await fixture.import();
after(() => { delete globalThis.pubUiR; fixture.dispose(); dom.window.close(); });

let root;
let container;
const settle = async () => { for (let tick = 0; tick < 12; tick += 1) await Promise.resolve(); };
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(PublishCard)));
	await act(settle);
}
const unmount = async () => { await act(async () => root.unmount()); container.remove(); };
const text = () => container.textContent;
const button = (label) => [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === label || node.getAttribute("aria-label") === label);
const click = async (label) => { await act(async () => { button(label).click(); await settle(); }); };
const reset = () => { Object.assign(globalThis.pubUiR, { calls: [], confirm: true, confirms: [], toasts: [], copied: [], clipboardFails: false }); };
const status = (enabled, extra = {}) => Response.json(enabled ? { enabled: true, createdAt: "2030-01-05T10:00:00.000Z", lastUsedAt: null, ...extra } : { enabled: false });
const server = (state = { on: false }) => (url, init) => {
	const method = init?.method ?? "GET";
	if (method === "GET") return status(state.on);
	if (method === "POST") { if (state.failPost) return Response.json({ error: "x" }, { status: 500 }); const created = !state.on; state.on = true; return Response.json(created ? { enabled: true, created: true, key: "ep_secret1" } : { enabled: true, created: false }); }
	if (method === "DELETE") { if (state.failDelete) return new Response("<html>bad gateway</html>", { status: 502 }); state.on = false; return Response.json({ enabled: false }); }
	throw new Error(method);
};


test("turning on when the link was already on (created: false) reloads the status, so the date is the real one, not an empty 'since .'", async () => {
	reset();
	let on = false;
	globalThis.pubUiR.respond = (url, init) => {
		if (init?.method === "POST") { on = true; return Response.json({ enabled: true, created: false }); }
		return on ? status(true, { createdAt: "2030-01-05T10:00:00.000Z" }) : status(false);
	};
	await mount();
	globalThis.pubUiR.calls.length = 0;
	await click("Turn on");
	assert.deepEqual(globalThis.pubUiR.calls.map((call) => call[1]), ["POST", "GET"]);
	assert.match(text(), /on since \d/);
	assert.doesNotMatch(text(), /since \./);
	await unmount();
});

test("if that reload fails, the card says so instead of showing a date it does not have", async () => {
	reset();
	globalThis.pubUiR.respond = (url, init) => (init?.method === "POST" ? Response.json({ enabled: true, created: false }) : init?.method === undefined && globalThis.pubUiR.calls.length > 2 ? new Response("x", { status: 500 }) : status(false));
	await mount();
	await click("Turn on");
	assert.match(text(), /Could not load the free\/busy link/);
	assert.doesNotMatch(text(), /since/);
	await unmount();
});

test("the card's own heading is left out when a dialog already titles it, so a screen reader hears the name once; alone it keeps its heading", async () => {
	reset();
	globalThis.pubUiR.respond = server();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(PublishCard, { hideTitle: true })));
	await act(settle);
	assert.equal(container.querySelectorAll("h3").length, 0);
	assert.doesNotMatch(text(), /Publish free\/busy/);
	assert.ok(button("Turn on"), "everything else is there");
	await unmount();
	await mount();
	assert.equal(container.querySelectorAll("h3").length, 1);
	await unmount();
});

test("the dialog hides the card's heading", () => {
	const dialog = readFileSync(new URL("../src/app/(calendar)/calendar/publish-dialog.tsx", import.meta.url), "utf8");
	assert.match(dialog, /<PublishCard hideTitle \/>/);
});

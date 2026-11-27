import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { loadFixture } from "./helpers/fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node", clipboard: { writeText: async (value) => { if (globalThis.pubUiR2.clipboardFails) throw new Error("denied"); globalThis.pubUiR2.copied.push(value); } } }, configurable: true });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.pubUiR2 = { en, respond: null, calls: [], confirm: true, confirms: [], toasts: [], copied: [], clipboardFails: false };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.pubUiR2.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/auth/client": "export async function authFetch(url,init){const s=globalThis.pubUiR2;s.calls.push([url,init?.method??'GET']);return s.respond(url,init)}",
	"@/components/ui/confirm-dialog": "export async function confirmDestructive(options){const s=globalThis.pubUiR2;s.confirms.push(options);return s.confirm}",
	"react-hot-toast": "export default {success:(m)=>globalThis.pubUiR2.toasts.push(['ok',m]),error:(m)=>globalThis.pubUiR2.toasts.push(['error',m])}",
};
const fixture = await loadFixture({ name: "pub-ui-review2", entryPoint: "src/app/(calendar)/calendar/publish-card.tsx", mocks });
const { PublishCard } = await fixture.import();
after(() => { delete globalThis.pubUiR2; fixture.dispose(); dom.window.close(); });

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
const reset = () => { Object.assign(globalThis.pubUiR2, { calls: [], confirm: true, confirms: [], toasts: [], copied: [], clipboardFails: false }); };
const status = (enabled, extra = {}) => Response.json(enabled ? { enabled: true, createdAt: "2030-01-05T10:00:00.000Z", lastUsedAt: null, ...extra } : { enabled: false });
const server = (state = { on: false }) => (url, init) => {
	const method = init?.method ?? "GET";
	if (method === "GET") return status(state.on);
	if (method === "POST") { if (state.failPost) return Response.json({ error: "x" }, { status: 500 }); const created = !state.on; state.on = true; return Response.json(created ? { enabled: true, created: true, key: "ep_secret1" } : { enabled: true, created: false }); }
	if (method === "DELETE") { if (state.failDelete) return new Response("<html>bad gateway</html>", { status: 502 }); state.on = false; return Response.json({ enabled: false }); }
	throw new Error(method);
};


const clickFocused = async (label) => { await act(async () => { const node = button(label); node.focus(); node.click(); await settle(); }); };

test("when the link was already on and the reload then fails, focus goes to Try again rather than being lost", async () => {
	reset();
	let posted = false;
	globalThis.pubUiR2.respond = (url, init) => (init?.method === "POST" ? (posted = true, Response.json({ enabled: true, created: false })) : posted ? new Response("x", { status: 500 }) : status(false));
	await mount();
	await clickFocused("Turn on");
	assert.ok(container.querySelector('[role="alert"]'));
	assert.ok(document.activeElement === button("Try again"), "focus is on Try again, not " + document.activeElement?.tagName);
	await unmount();
});

test("pressing Try again and getting an answer does not move focus off the page's flow: it lands on the action that is now offered", async () => {
	reset();
	let posted = false;
	let fail = true;
	globalThis.pubUiR2.respond = (url, init) => (init?.method === "POST" ? (posted = true, Response.json({ enabled: true, created: false })) : posted && fail ? new Response("x", { status: 500 }) : status(posted));
	await mount();
	await clickFocused("Turn on");
	fail = false;
	await clickFocused("Try again");
	assert.ok(button("Turn off"));
	await unmount();
});

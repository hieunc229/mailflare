import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { loadFixture } from "./helpers/fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.orgCard = { en, respond: null, calls: [] };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.orgCard.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/auth/client": "export async function authFetch(url,init){const s=globalThis.orgCard;s.calls.push([url,init?.method??'GET']);return s.respond(url,init)}",
};
const fixture = await loadFixture({ name: "org-fb-card", entryPoint: "src/app/(admin)/general/org-free-busy-card.tsx", mocks });
const { OrgFreeBusyCard } = await fixture.import();
after(() => { delete globalThis.orgCard; fixture.dispose(); dom.window.close(); });

let root;
let container;
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(OrgFreeBusyCard)));
	await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const unmount = async () => { await act(async () => root.unmount()); container.remove(); };
const text = () => container.textContent;
const flip = async () => { await act(async () => { container.querySelector('[role="switch"]').click(); await Promise.resolve(); await Promise.resolve(); }); };

test("a failed save whose body is not JSON shows the translated generic error, never a parser message", async () => {
	globalThis.orgCard.respond = (url, init) => (init?.method === "PUT" ? new Response("<html>Bad gateway</html>", { status: 502 }) : Response.json({ available: true, enabled: false }));
	await mount();
	await flip();
	assert.match(text(), /Could not save this setting\./);
	assert.doesNotMatch(text(), /JSON|Unexpected|<html>/);
	assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "false", "the switch shows what is stored");
	await unmount();
});

test("a refusal with a JSON body is also the generic translated error", async () => {
	globalThis.orgCard.respond = (url, init) => (init?.method === "PUT" ? Response.json({ error: "Organisation-wide free/busy needs a Team licence" }, { status: 403 }) : Response.json({ available: true, enabled: false }));
	await mount();
	await flip();
	assert.match(text(), /Could not save this setting\./);
	await unmount();
});

test("a load whose body is not JSON is the retryable error, and a network failure on save is the generic error", async () => {
	globalThis.orgCard.respond = () => new Response("<html>", { status: 500 });
	await mount();
	assert.match(text(), /Could not load this setting\./);
	await unmount();
	globalThis.orgCard.respond = (url, init) => { if (init?.method === "PUT") throw new TypeError("Failed to fetch"); return Response.json({ available: true, enabled: false }); };
	await mount();
	await flip();
	assert.match(text(), /Could not save this setting\./);
	assert.doesNotMatch(text(), /Failed to fetch/);
	await unmount();
});

test("a good save is announced", async () => {
	globalThis.orgCard.respond = (url, init) => Response.json(init?.method === "PUT" ? { available: true, enabled: true } : { available: true, enabled: false });
	await mount();
	await flip();
	assert.match(text(), /Saved/);
	assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "true");
	await unmount();
});

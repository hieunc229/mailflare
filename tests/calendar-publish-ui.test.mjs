import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { loadFixture } from "./helpers/fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node", clipboard: { writeText: async (value) => { if (globalThis.pubUi.clipboardFails) throw new Error("denied"); globalThis.pubUi.copied.push(value); } } }, configurable: true });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.pubUi = { en, respond: null, calls: [], confirm: true, confirms: [], toasts: [], copied: [], clipboardFails: false };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.pubUi.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/auth/client": "export async function authFetch(url,init){const s=globalThis.pubUi;s.calls.push([url,init?.method??'GET']);return s.respond(url,init)}",
	"@/components/ui/confirm-dialog": "export async function confirmDestructive(options){const s=globalThis.pubUi;s.confirms.push(options);return s.confirm}",
	"react-hot-toast": "export default {success:(m)=>globalThis.pubUi.toasts.push(['ok',m]),error:(m)=>globalThis.pubUi.toasts.push(['error',m])}",
};
const fixture = await loadFixture({ name: "pub-ui", entryPoint: "src/app/(calendar)/calendar/publish-card.tsx", mocks });
const { PublishCard } = await fixture.import();
after(() => { delete globalThis.pubUi; fixture.dispose(); dom.window.close(); });

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
const reset = () => { Object.assign(globalThis.pubUi, { calls: [], confirm: true, confirms: [], toasts: [], copied: [], clipboardFails: false }); };
const status = (enabled, extra = {}) => Response.json(enabled ? { enabled: true, createdAt: "2030-01-05T10:00:00.000Z", lastUsedAt: null, ...extra } : { enabled: false });
const server = (state = { on: false }) => (url, init) => {
	const method = init?.method ?? "GET";
	if (method === "GET") return status(state.on);
	if (method === "POST") { if (state.failPost) return Response.json({ error: "x" }, { status: 500 }); const created = !state.on; state.on = true; return Response.json(created ? { enabled: true, created: true, key: "ep_secret1" } : { enabled: true, created: false }); }
	if (method === "DELETE") { if (state.failDelete) return new Response("<html>bad gateway</html>", { status: 502 }); state.on = false; return Response.json({ enabled: false }); }
	throw new Error(method);
};

test("while loading it says so (role=status); off shows what is shared and one primary action", async () => {
	reset();
	let release;
	globalThis.pubUi.respond = () => new Promise((resolve) => { release = () => resolve(status(false)); });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(PublishCard)));
	assert.ok(container.querySelector('[role="status"]'), "a loading status");
	assert.match(text(), /Checking the link/);
	await act(async () => { release(); await settle(); });
	assert.match(text(), /never titles, places or guests/);
	assert.match(text(), /Private events count as busy/);
	assert.ok(button("Turn on"));
	assert.equal(container.querySelectorAll("input").length, 0, "no URLs while off");
	await unmount();
});

test("a failed load shows an alert with Try again, which loads again", async () => {
	reset();
	let ok = false;
	globalThis.pubUi.respond = () => (ok ? status(false) : new Response("nope", { status: 500 }));
	await mount();
	assert.ok(container.querySelector('[role="alert"]'));
	assert.match(text(), /Could not load the free\/busy link/);
	assert.ok(!button("Turn on"), "no action on a state that is unknown");
	ok = true;
	await click("Try again");
	assert.ok(button("Turn on"));
	await unmount();
});

test("turning on shows both URLs once, each with a labelled input and a Copy button that copies exactly that URL", async () => {
	reset();
	globalThis.pubUi.respond = server();
	await mount();
	await click("Turn on");
	assert.deepEqual(globalThis.pubUi.calls.map((call) => call.join(" ")), ["/api/calendar/freebusy-link GET", "/api/calendar/freebusy-link POST"]);
	const inputs = [...container.querySelectorAll("input")];
	assert.deepEqual(inputs.map((input) => input.value), ["https://mail.example/api/calendar/freebusy?key=ep_secret1", "https://mail.example/api/calendar/freebusy?key=ep_secret1&format=ics"]);
	for (const input of inputs) { assert.ok(input.readOnly); assert.ok(input.id && container.querySelector(`label[for="${input.id}"]`), "an input has a visible label"); }
	assert.match(text(), /cannot be shown again/);
	await click("Copy Busy-only calendar (.ics)");
	assert.deepEqual(globalThis.pubUi.copied, ["https://mail.example/api/calendar/freebusy?key=ep_secret1&format=ics"]);
	await click("Copy Free/busy file (.ifb)");
	assert.equal(globalThis.pubUi.copied[1], "https://mail.example/api/calendar/freebusy?key=ep_secret1");
	assert.deepEqual(globalThis.pubUi.toasts, [["ok", "Link copied"], ["ok", "Link copied"]]);
	assert.ok(button("Turn off"));
	await unmount();
});

test("a clipboard that refuses says so and keeps the link selectable", async () => {
	reset();
	globalThis.pubUi.respond = server();
	await mount();
	await click("Turn on");
	globalThis.pubUi.clipboardFails = true;
	await click("Copy Free/busy file (.ifb)");
	assert.deepEqual(globalThis.pubUi.toasts, [["error", "Could not copy. Select the link and copy it by hand."]]);
	await unmount();
});

test("a link that was already on explains that it cannot be shown again, shows no URL, and offers Turn off", async () => {
	reset();
	globalThis.pubUi.respond = server({ on: true });
	await mount();
	assert.equal(container.querySelectorAll("input").length, 0);
	assert.match(text(), /on since /);
	assert.match(text(), /cannot be shown again/);
	assert.ok(button("Turn off"));
	assert.ok(!button("Turn on"));
	await unmount();
});

test("turning on twice at once (the server says created: false) shows the explanation, not a second set of links", async () => {
	reset();
	const state = { on: false };
	globalThis.pubUi.respond = (url, init) => (init?.method === "POST" ? (state.on = true, Response.json({ enabled: true, created: false })) : status(state.on));
	await mount();
	await click("Turn on");
	assert.equal(container.querySelectorAll("input").length, 0);
	assert.ok(button("Turn off"));
	await unmount();
});

test("a failed turn-on says so, stays off, and can be tried again", async () => {
	reset();
	const state = { on: false, failPost: true };
	globalThis.pubUi.respond = server(state);
	await mount();
	await click("Turn on");
	assert.match(text(), /Could not change the free\/busy link/);
	assert.ok(container.querySelector('[role="alert"]'));
	assert.ok(button("Turn on") && !button("Turn on").disabled);
	state.failPost = false;
	await click("Turn on");
	assert.equal(container.querySelectorAll("input").length, 2);
	assert.doesNotMatch(text(), /Could not change/);
	await unmount();
});

test("the button is disabled while the request runs, so a double click sends one request", async () => {
	reset();
	let release;
	globalThis.pubUi.respond = (url, init) => (init?.method === "POST" ? new Promise((resolve) => { release = () => resolve(Response.json({ enabled: true, created: true, key: "ep_k" })); }) : status(false));
	await mount();
	await act(async () => { button("Turn on").click(); await settle(); });
	const pending = button("Turning on…");
	assert.ok(pending && pending.disabled);
	assert.equal(pending.getAttribute("aria-busy"), "true");
	await act(async () => { pending.click(); await settle(); });
	assert.equal(globalThis.pubUi.calls.filter((call) => call[1] === "POST").length, 1);
	await act(async () => { release(); await settle(); });
	assert.equal(container.querySelectorAll("input").length, 2);
	await unmount();
});

test("turning off asks first, in the destructive style; cancelling changes nothing; confirming deletes and shows the off state", async () => {
	reset();
	const state = { on: true };
	globalThis.pubUi.respond = server(state);
	await mount();
	globalThis.pubUi.confirm = false;
	await click("Turn off");
	assert.equal(globalThis.pubUi.confirms.length, 1);
	assert.match(globalThis.pubUi.confirms[0].message, /stops working at once/);
	assert.equal(globalThis.pubUi.confirms[0].confirmLabel, "Turn off");
	assert.ok(!globalThis.pubUi.calls.some((call) => call[1] === "DELETE"));
	assert.ok(button("Turn off"));
	globalThis.pubUi.confirm = true;
	await click("Turn off");
	assert.ok(globalThis.pubUi.calls.some((call) => call[1] === "DELETE"));
	assert.ok(button("Turn on"));
	assert.deepEqual(globalThis.pubUi.toasts, [["ok", "Free/busy link turned off"]]);
	await unmount();
});

test("a failed turn-off (the body is not JSON) shows the translated error and keeps the link on", async () => {
	reset();
	globalThis.pubUi.respond = server({ on: true, failDelete: true });
	await mount();
	await click("Turn off");
	assert.match(text(), /Could not change the free\/busy link/);
	assert.doesNotMatch(text(), /<html>|JSON|Unexpected/);
	assert.ok(button("Turn off"));
	await unmount();
});

test("the on/off status is text, not colour alone, and the section is named", async () => {
	reset();
	globalThis.pubUi.respond = server({ on: true });
	await mount();
	const section = container.querySelector("section");
	assert.ok(section && section.getAttribute("aria-labelledby") && container.querySelector(`#${section.getAttribute("aria-labelledby")}`));
	assert.ok([...container.querySelectorAll("span")].some((node) => node.textContent === "On"), "a status word");
	await unmount();
});

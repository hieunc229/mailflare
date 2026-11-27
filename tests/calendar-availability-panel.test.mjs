import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, mock } from "node:test";
import { JSDOM } from "jsdom";
import { loadFixture } from "./helpers/fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.panelT = { en, calls: [], responder: null };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.panelT.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/auth/client": "export async function authFetch(url,init){const s=globalThis.panelT;const body=JSON.parse(init.body);s.calls.push({url,body});return s.responder(body)}",
};
const fixture = await loadFixture({ name: "cal-avail-panel", entryPoint: "src/app/(calendar)/calendar/availability-panel.tsx", mocks });
const { AvailabilityPanel } = await fixture.import();
after(() => { delete globalThis.panelT; fixture.dispose(); dom.window.close(); });

const DAY = 86_400_000;
const ok = (results) => Response.json({ results });
let root;
let container;
const ticks = async (ms = 0) => { await act(async () => { mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); }); };
async function mount(props) {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	globalThis.panelT.calls = [];
	const picks = [];
	const element = (next) => createElement(AvailabilityPanel, { guests: "", startsAt: "2030-01-09T09:00", endsAt: "2030-01-09T10:00", onPick: (start, end) => picks.push([start, end]), ...next });
	await act(async () => root.render(element(props)));
	return { picks, update: async (next) => act(async () => root.render(element({ ...props, ...next }))) };
}
const setup = () => { mock.timers.enable({ apis: ["setTimeout"] }); };
const teardown = async () => { await act(async () => root.unmount()); container.remove(); mock.timers.reset(); };
const text = () => container.textContent;

test("without guests it shows the hint and asks the server nothing", async () => {
	setup();
	await mount({});
	await ticks(1000);
	assert.match(text(), /Add guests to see when they are free\./);
	assert.equal(globalThis.panelT.calls.length, 0);
	await teardown();
});

test("typing guests is debounced by 400 ms into one request for the event's day and a day either side, then rows appear", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, address.startsWith("x") ? { status: "unknown" } : { status: "ok", busy: [] }])));
	const view = await mount({ guests: "ann@one.test" });
	await view.update({ guests: "ann@one.test, x@else.test" });
	await ticks(399);
	assert.equal(globalThis.panelT.calls.length, 0, "not before 400 ms");
	assert.match(text(), /Checking availability/);
	await ticks(1);
	assert.equal(globalThis.panelT.calls.length, 1, "one request for the last text");
	const [{ url, body }] = globalThis.panelT.calls;
	assert.equal(url, "/api/calendar/free-busy");
	assert.deepEqual(body.addresses, ["ann@one.test", "x@else.test"]);
	const span = new Date(body.end).getTime() - new Date(body.start).getTime();
	assert.ok(Math.abs(span - 3 * DAY) <= 3_600_000, `three days, was ${span / DAY}`);
	assert.ok(new Date(body.start) < new Date(Date.UTC(2030, 0, 9, 9)) && new Date(body.end) > new Date(Date.UTC(2030, 0, 10, 12)));
	await ticks(0);
	assert.match(text(), /ann@one\.test/);
	assert.match(text(), /No access/);
	await teardown();
});

test("a failed request shows the error and a retry that asks again; a late answer for old guests is ignored", async () => {
	setup();
	globalThis.panelT.responder = () => new Response("{}", { status: 500 });
	const view = await mount({ guests: "ann@one.test" });
	await ticks(400);
	await ticks(0);
	assert.match(text(), /You can still save the event/);
	globalThis.panelT.responder = (body) => ok({ [body.addresses[0]]: { status: "ok", busy: [] } });
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again").click(); });
	await ticks(400);
	await ticks(0);
	assert.equal(globalThis.panelT.calls.length, 2);
	assert.match(text(), /ann@one\.test: free all day/);
	// A slow answer for the first guest list must not replace the second one's.
	let release;
	globalThis.panelT.responder = (body) => (body.addresses[0] === "slow@one.test" ? new Promise((resolve) => { release = () => resolve(ok({ "slow@one.test": { status: "ok", busy: [] } })); }) : ok({ "fast@one.test": { status: "ok", busy: [] } }));
	await view.update({ guests: "slow@one.test" });
	await ticks(400);
	await view.update({ guests: "fast@one.test" });
	await ticks(400);
	await ticks(0);
	await act(async () => { release(); await Promise.resolve(); });
	assert.match(text(), /fast@one\.test/);
	assert.doesNotMatch(text(), /slow@one\.test/);
	await teardown();
});

test("Find a time asks once for the next 14 days, offers three slots of the event's length, and picking one hands them to the editor", async () => {
	setup();
	const now = Date.now();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	const view = await mount({ guests: "ann@one.test", startsAt: "2030-01-09T09:00", endsAt: "2030-01-09T10:30" });
	await ticks(400);
	await ticks(0);
	globalThis.panelT.calls.length = 0;
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.equal(globalThis.panelT.calls.length, 1);
	const { body } = globalThis.panelT.calls[0];
	assert.ok(Math.abs(new Date(body.start).getTime() - now) < 5000, "from now");
	assert.ok(Math.abs(new Date(body.end).getTime() - now - 14 * DAY) <= 2 * DAY + 5000, "about 14 days on");
	const suggestions = [...container.querySelectorAll('ul[aria-labelledby] button')];
	assert.equal(suggestions.length, 3);
	await act(async () => { suggestions[1].click(); });
	assert.equal(view.picks.length, 1);
	assert.equal(view.picks[0][1].getTime() - view.picks[0][0].getTime(), 90 * 60_000, "same length as the event");
	await teardown();
});

test("Find a time that fails says so, and one with nobody free says that", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	await mount({ guests: "ann@one.test" });
	await ticks(400);
	await ticks(0);
	globalThis.panelT.responder = () => new Response("{}", { status: 503 });
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.match(text(), /Could not look for a time/);
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [[new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 20 * DAY).toISOString()]] }])));
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.match(text(), /No time in the next 14 days/);
	await teardown();
});

test("an event whose times are not valid yet asks nothing", async () => {
	setup();
	await mount({ guests: "ann@one.test", startsAt: "", endsAt: "" });
	await ticks(1000);
	assert.equal(globalThis.panelT.calls.length, 0);
	await teardown();
});

test("when an existing event is being edited, both the availability read and Find a time name it so it does not clash with itself", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	await mount({ guests: "ann@one.test", excludeEventId: "evt_1" });
	await ticks(400);
	await ticks(0);
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.equal(globalThis.panelT.calls.length, 2);
	assert.deepEqual(globalThis.panelT.calls.map(({ body }) => body.excludeEventId), ["evt_1", "evt_1"]);
	await teardown();
});

test("a new event sends no excludeEventId", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	await mount({ guests: "ann@one.test" });
	await ticks(400);
	await ticks(0);
	assert.equal("excludeEventId" in globalThis.panelT.calls[0].body, false);
	await teardown();
});

test("Find a time counts the organiser's own busy time too: their address is asked for, is not listed as a guest, and a slot they are busy in is not offered", async () => {
	setup();
	const answers = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, address === "me@one.test"
		? { status: "ok", busy: [[new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 20 * DAY).toISOString()]] }
		: { status: "ok", busy: [] }])));
	globalThis.panelT.responder = answers;
	await mount({ guests: "ann@one.test", selfAddress: "Me@One.test" });
	await ticks(400);
	await ticks(0);
	assert.deepEqual(globalThis.panelT.calls[0].body.addresses, ["ann@one.test"], "the read for the rows asks about the guests only");
	assert.doesNotMatch(text(), /me@one\.test/);
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.deepEqual(globalThis.panelT.calls[1].body.addresses, ["ann@one.test", "me@one.test"]);
	assert.match(text(), /No time in the next 14 days/);
	await teardown();
});

test("the organiser who is also on the guest list is asked for once", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	await mount({ guests: "ann@one.test, me@one.test", selfAddress: "me@one.test" });
	await ticks(400);
	await ticks(0);
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.deepEqual(globalThis.panelT.calls[1].body.addresses, ["ann@one.test", "me@one.test"]);
	await teardown();
});

test("changing the guests keeps the rows already shown until the new answer arrives, and announces nothing new", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	const view = await mount({ guests: "ann@one.test" });
	await ticks(400);
	await ticks(0);
	assert.match(text(), /ann@one\.test/);
	let release;
	globalThis.panelT.responder = () => new Promise((resolve) => { release = () => resolve(ok({ "ann@one.test": { status: "ok", busy: [] }, "bob@one.test": { status: "ok", busy: [] } })); });
	await view.update({ guests: "ann@one.test, bob@one.test" });
	await ticks(400);
	assert.match(text(), /ann@one\.test/, "the row stays while the next answer is awaited");
	assert.doesNotMatch(text(), /bob@one\.test/, "a new address has no row until it is answered");
	assert.equal(container.querySelectorAll('[role="status"]').length, 1, "one persistent status");
	assert.equal(container.querySelector('[role="status"]').textContent, "Updating availability...");
	assert.equal(container.querySelector("ul")?.getAttribute("aria-busy"), "true");
	await act(async () => { release(); await Promise.resolve(); });
	await ticks(0);
	assert.match(text(), /bob@one\.test/);
	assert.equal(container.querySelector("ul")?.getAttribute("aria-busy"), null);
	await teardown();
});

test("moving the event to another day does not keep the old day's rows, which would read as free", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	const view = await mount({ guests: "ann@one.test" });
	await ticks(400);
	await ticks(0);
	globalThis.panelT.responder = () => new Promise(() => {});
	await view.update({ startsAt: "2030-03-20T09:00", endsAt: "2030-03-20T10:00" });
	await ticks(400);
	assert.doesNotMatch(text(), /ann@one\.test/);
	assert.match(text(), /Checking availability/);
	await teardown();
});

test("with 50 guests Find a time drops the organiser's own calendar, not a guest, and says so", async () => {
	setup();
	const guests = Array.from({ length: 50 }, (_, index) => `g${index}@one.test`);
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	await mount({ guests: guests.join(","), selfAddress: "me@one.test" });
	await ticks(400);
	await ticks(0);
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.deepEqual(globalThis.panelT.calls[1].body.addresses, guests, "all 50 guests, no 51st");
	assert.match(text(), /your own calendar is not included/);
	await teardown();
});

test("with room to spare there is no such note", async () => {
	setup();
	globalThis.panelT.responder = (body) => ok(Object.fromEntries(body.addresses.map((address) => [address, { status: "ok", busy: [] }])));
	await mount({ guests: "ann@one.test", selfAddress: "me@one.test" });
	await ticks(400);
	await ticks(0);
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Find a time").click(); });
	await ticks(0);
	assert.doesNotMatch(text(), /your own calendar is not included/);
	await teardown();
});

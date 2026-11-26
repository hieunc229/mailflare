import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.availUi = { en };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.availUi.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
};
mocks["@/lib/time/utils"] = 'export function formatUserDate(value,options){return new Intl.DateTimeFormat("en-US",options).format(new Date(value))} export const zonedDateFields=()=>{throw new Error("unused")}; export const dateFromZonedFields=zonedDateFields;';
const fixture = await loadFixture({ name: "cal-avail-ui", entryPoint: "src/app/(calendar)/calendar/availability-view.tsx", mocks });
const { AvailabilityView } = await fixture.import();
after(() => { delete globalThis.availUi; fixture.dispose(); });

const D = (h, min = 0, day = 9) => new Date(Date.UTC(2030, 0, day, h, min));
const iso = (date) => date.toISOString();
const base = {
	zone: "UTC", guestCount: 2, truncated: false, state: "ready", rows: [], dayStart: D(0), dayEnd: D(0, 0, 10), event: { start: D(9), end: D(10) },
	find: { state: "idle", slots: [] }, canFind: true, onRetry: () => {}, onFind: () => {}, onPick: () => {},
};
const render = (props) => renderToStaticMarkup(createElement(AvailabilityView, { ...base, ...props }));
const busy = (a, b) => ({ address: "ann@one.test", availability: { status: "ok", busy: [[iso(a), iso(b)]] } });

test("no guests: a hint says what to do, and there is no Find a time", () => {
	const html = render({ guestCount: 0, rows: [] });
	assert.match(html, /Add guests to see when they are free\./);
	assert.doesNotMatch(html, /Find a time/);
});

test("loading is announced politely and shows no rows", () => {
	const html = render({ state: "loading" });
	assert.match(html, /<p role="status" class="sr-only">Checking availability\.\.\.<\/p>/);
	assert.match(html, />Checking availability\.\.\.<\/p>/, "and the same words are visible");
	assert.doesNotMatch(html, /<li/);
});

test("an error says saving still works and offers a retry; the rest of the editor is unaffected", () => {
	const html = render({ state: "error" });
	assert.match(html, /role="alert"/);
	assert.match(html, /You can still save the event/);
	assert.match(html, /<button[^>]*>Try again<\/button>/);
});

test("a row shows the person, whether they clash with the event in words, busy blocks for the eye and the same times in text for a screen reader", () => {
	const html = render({ rows: [busy(D(9, 30), D(11)), { address: "bob@one.test", availability: { status: "ok", busy: [[iso(D(14)), iso(D(15))]] } }] });
	assert.match(html, /ann@one\.test/);
	assert.match(html, /Busy during this event/);
	assert.match(html, /Free during this event/);
	assert.match(html, /class="sr-only"[^>]*>ann@one\.test: busy 9:30 AM to 11:00 AM</);
	assert.match(html, /class="sr-only"[^>]*>bob@one\.test: busy 2:00 PM to 3:00 PM</);
	const blocks = [...html.matchAll(/data-busy-block[^>]*style="left:([\d.]+)%;width:([\d.]+)%"/g)];
	assert.equal(blocks.length, 2);
	assert.equal(Number(blocks[0][1]), 39.58333333333333);
	assert.match(html.match(/data-busy-block[^>]*/)[0], /aria-hidden="true"/);
});

test("a person with no busy time is free all day, in text too", () => {
	const html = render({ rows: [{ address: "ann@one.test", availability: { status: "ok", busy: [] } }] });
	assert.match(html, /ann@one\.test: free all day/);
	assert.doesNotMatch(html, /data-busy-block/);
});

test("a person whose availability cannot be seen says No access, without saying why", () => {
	const html = render({ rows: [{ address: "x@elsewhere.test", availability: { status: "unknown" } }] });
	assert.match(html, />No access</);
	assert.match(html, /x@elsewhere\.test: their availability is not shared with you/);
	assert.doesNotMatch(html, /data-busy-block/);
	assert.doesNotMatch(html, /Free during this event|Busy during this event/);
});

test("the event's own span is marked on each bar", () => {
	const html = render({ rows: [busy(D(13), D(14))] });
	assert.match(html, /data-event-span[^>]*style="left:37\.5%;width:4\.166/);
});

test("more than 50 guests: it says only the first are shown", () => {
	assert.match(render({ truncated: true, rows: [busy(D(1), D(2))] }), /Showing the first 50 guests\./);
});

test("Find a time: a button when people can be seen, a reason when not, disabled while checking", () => {
	assert.match(render({}), /<button[^>]*type="button"[^>]*>Find a time<\/button>/);
	assert.doesNotMatch(render({}).match(/<button[^>]*>Find a time/)[0], /\sdisabled=""/);
	const none = render({ canFind: false, rows: [{ address: "x@y.test", availability: { status: "unknown" } }] });
	assert.match(none, /<button[^>]*\sdisabled=""[^>]*>Find a time<\/button>/);
	assert.match(none, /needs at least one guest whose availability you can see/);
	assert.match(render({ state: "loading", canFind: false }), /<button[^>]*\sdisabled=""[^>]*>Find a time<\/button>/);
});

test("Find a time: looking, failing, nothing found and the suggestions are each announced; a suggestion is a button that names its time", () => {
	assert.match(render({ find: { state: "loading", slots: [] } }), /<p role="status" class="sr-only">Looking for a time\.\.\.<\/p>/);
	assert.match(render({ find: { state: "error", slots: [] } }), /role="alert"[^>]*>.*Could not look for a time/);
	assert.match(render({ find: { state: "ready", slots: [] } }), /<p role="status" class="sr-only">No time in the next 14 days/);
	const html = render({ find: { state: "ready", slots: [{ start: D(10), end: D(11) }, { start: D(12), end: D(13) }] } });
	assert.doesNotMatch(html, /aria-live/);
	assert.match(html, /<p role="status" class="sr-only">Suggested times<\/p>/);
	assert.equal((html.match(/Suggested times/g) ?? []).length, 2, "the one announcement and the visible heading; the list takes its name from the heading by reference");
	assert.doesNotMatch(html, /role="group"|aria-label="Suggested times"/, "the heading is not also a second label");
	assert.match(html, /<ul[^>]*aria-labelledby=/);
	assert.match(html, /Suggested times/);
	const buttons = [...html.matchAll(/<button[^>]*aria-label="Use ([^"]+)"[^>]*>([^<]+)</g)];
	assert.equal(buttons.length, 2);
	assert.match(buttons[0][1], /10:00 AM/);
	assert.match(buttons[0][1], /11:00 AM/);
});

test("touch targets are 44 px on coarse pointers and no control hides its focus ring", () => {
	const html = render({ rows: [busy(D(9), D(10))], find: { state: "ready", slots: [{ start: D(10), end: D(11) }] } });
	for (const button of html.match(/<button[^>]*>/g)) {
		assert.match(button, /\[@media\(pointer:coarse\)\]:min-h-11/);
		assert.doesNotMatch(button, /outline-none/);
	}
});

test("an event too long for the working day says Find a time cannot help, instead of reporting no free time", () => {
	const html = render({ canFind: false, tooLong: true, rows: [busy(D(1), D(2))] });
	assert.match(html, /Find a time works for events up to 10 hours/);
	assert.match(html, /<button[^>]*\sdisabled=""[^>]*>Find a time<\/button>/);
	assert.doesNotMatch(render({ rows: [busy(D(1), D(2))] }), /up to 10 hours/);
});

test("loading again with rows already shown keeps them, dimmed and marked busy, and says Updating in the one status", () => {
	const html = render({ state: "loading", rows: [busy(D(9), D(10))] });
	assert.match(html, /ann@one\.test/);
	assert.match(html, /<ul[^>]*aria-busy="true"/);
	assert.match(html, /<p role="status" class="sr-only">Updating availability\.\.\.<\/p>/);
	assert.match(html, /opacity-60/);
	assert.doesNotMatch(render({ rows: [busy(D(9), D(10))] }), /aria-busy="true"|opacity-60/);
});

test("exactly one live status is always mounted while there are guests, whatever the state, and its text is what changes", () => {
	for (const props of [{}, { state: "loading" }, { state: "loading", rows: [busy(D(9), D(10))] }, { state: "error" }, { find: { state: "loading", slots: [] } }, { find: { state: "ready", slots: [{ start: D(10), end: D(11) }] } }]) {
		assert.equal((render(props).match(/role="status"/g) ?? []).length, 1, JSON.stringify(Object.keys(props)));
	}
	assert.match(render({}), /<p role="status" class="sr-only"><\/p>/, "empty, but there, so the first announcement is heard");
});

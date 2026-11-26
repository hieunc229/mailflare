import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.calListEn = en;
const mocks = {
	"./calendar-state": "export const useCalendarState=()=>globalThis.calListState; export const toggleCalendar=()=>{}; export const openCalendarSettings=()=>{}; export const retryCalendars=()=>{};",
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.calListEn[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
};
const list = await loadFixture({ name: "calendar-multi-list", entryPoint: "src/app/(calendar)/calendar/calendar-list.tsx", mocks });
const utils = await loadFixture({ name: "calendar-multi-list-utils", entryPoint: "src/app/(calendar)/calendar/calendar-list-utils.ts", mocks });
const { CalendarList } = await list.import();
const { toggleHidden, visibleCalendarEvents, calendarErrorKey, nextColor } = await utils.import();
after(() => { delete globalThis.calListEn; delete globalThis.calListState; list.dispose(); utils.dispose(); });

const calendars = [
	{ id: "cal:u1", name: null, color: "#2563eb", description: "", isDefault: true, role: "owner" },
	{ id: "cal:work", name: "Work", color: "#7c3aed", description: "", isDefault: false, role: "owner" },
];
const render = (props = {}) => { globalThis.calListState = { calendars, state: "ready", hidden: [], settings: null, revision: 0, ...props }; return renderToStaticMarkup(createElement(CalendarList)); };

test("ready: one labelled checkbox per calendar (the unnamed default uses the localised name), checked unless hidden, plus a settings button each", () => {
	const html = render({ hidden: ["cal:work"] });
	assert.match(html, /aria-label="Show My calendar"[^>]*checked/);
	assert.doesNotMatch(html.match(/<input[^>]*Show Work[^>]*>/)[0], /checked/);
	assert.match(html, /aria-label="Settings for Work"/);
	assert.match(html, /aria-label="Add calendar"/);
	assert.match(html, /accent-color:#7c3aed/);
});

test("loading shows a status line and no list; error shows an alert with a retry button", () => {
	const loading = render({ state: "loading" });
	assert.match(loading, /role="status"/);
	assert.doesNotMatch(loading, /<ul/);
	const error = render({ state: "error" });
	assert.match(error, /role="alert"/);
	assert.match(error, /Try again/);
	assert.doesNotMatch(error, /<ul/);
});

test("coarse pointers get 44px targets on every control", () => {
	const html = render();
	assert.equal((html.match(/min-h-11/g) ?? []).length >= 5, true);
});

test("hidden calendars drop their events; events without a calendar id belong to the default calendar", () => {
	const events = [{ id: "a" }, { id: "b", calendarId: "cal:work" }, { id: "c", calendarId: "cal:u1" }];
	assert.deepEqual(visibleCalendarEvents(events, [], "cal:u1").map((e) => e.id), ["a", "b", "c"]);
	assert.deepEqual(visibleCalendarEvents(events, ["cal:work"], "cal:u1").map((e) => e.id), ["a", "c"]);
	assert.deepEqual(visibleCalendarEvents(events, ["cal:u1"], "cal:u1").map((e) => e.id), ["b"]);
	assert.deepEqual(toggleHidden(["x"], "y"), ["x", "y"]);
	assert.deepEqual(toggleHidden(["x", "y"], "x"), ["y"]);
});

test("server errors map to translated messages by status, never the English server text", () => {
	assert.equal(calendarErrorKey("save", 409), "calendar.calendars.error.limit");
	assert.equal(calendarErrorKey("save", 400), "calendar.calendars.error.invalid");
	assert.equal(calendarErrorKey("save", 404), "calendar.calendars.error.notFound");
	assert.equal(calendarErrorKey("save", 500), "calendar.calendars.saveFailed");
	assert.equal(calendarErrorKey("delete", 409), "calendar.calendars.error.defaultCalendar");
	assert.equal(calendarErrorKey("delete", 404), "calendar.calendars.error.notFound");
	assert.equal(calendarErrorKey("delete", 0), "calendar.calendars.deleteFailed");
	for (const key of ["limit", "invalid", "notFound", "defaultCalendar"]) assert.ok(en[`calendar.calendars.error.${key}`], key);
});

test("the delete confirmation names the event count with singular and plural wording", () => {
	assert.match(en["calendar.calendars.deleteConfirm.one"], /\{name\}/);
	assert.match(en["calendar.calendars.deleteConfirm.other"], /\{count\}/);
});

test("the colour group moves with the arrow keys, wrapping, and ignores other keys", () => {
	const values = ["a", "b", "c"];
	assert.equal(nextColor(values, "a", "ArrowRight"), "b");
	assert.equal(nextColor(values, "c", "ArrowRight"), "a");
	assert.equal(nextColor(values, "a", "ArrowLeft"), "c");
	assert.equal(nextColor(values, "b", "ArrowDown"), "c");
	assert.equal(nextColor(values, "b", "ArrowUp"), "a");
	assert.equal(nextColor(values, "b", "Home"), "a");
	assert.equal(nextColor(values, "b", "End"), "c");
	assert.equal(nextColor(values, "b", "Enter"), null);
});

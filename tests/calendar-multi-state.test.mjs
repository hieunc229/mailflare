import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

globalThis.calState = { storage: new Map(), responses: [], calls: 0 };
globalThis.window = { localStorage: { getItem: (key) => globalThis.calState.storage.get(key) ?? null, setItem: (key, value) => void globalThis.calState.storage.set(key, value) } };
const fixture = await loadFixture({
	name: "calendar-multi-state",
	entryPoint: "src/app/(calendar)/calendar/calendar-state.ts",
	mocks: {
		"@/lib/auth/client": "export async function authFetch(){const s=globalThis.calState;s.calls++;const next=s.responses.shift();if(next instanceof Error)throw next;return Response.json(next.body,{status:next.status??200})}",
		react: "export function useSyncExternalStore(){return null} export function useEffect(){}",
	},
});
const state = await fixture.import();
after(() => { delete globalThis.calState; delete globalThis.window; fixture.dispose(); });

const work = { id: "cal:work", name: "Work", color: "#7c3aed", description: "", isDefault: false, role: "owner", eventCount: 3 };
const home = { id: "cal:u1", name: null, color: "#2563eb", description: "", isDefault: true, role: "owner", eventCount: 0 };
const ok = (calendars) => ({ body: { calendars } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => { globalThis.calState.storage.clear(); globalThis.calState.responses = []; globalThis.calState.calls = 0; state.resetCalendarState(); });

test("starting loads the calendars and the hidden ids kept in this browser", async () => {
	globalThis.calState.storage.set("mailflare.calendar.hidden", JSON.stringify(["cal:work"]));
	globalThis.calState.responses.push(ok([home, work]));
	assert.equal(state.getCalendarSnapshot().state, "loading");
	state.startCalendarState();
	await settle();
	const snapshot = state.getCalendarSnapshot();
	assert.deepEqual([snapshot.state, snapshot.calendars.length, snapshot.hidden], ["ready", 2, ["cal:work"]]);
	state.startCalendarState();
	await settle();
	assert.equal(globalThis.calState.calls, 1, "a second consumer does not fetch again");
});

test("a failed first load is an error the list can retry", async () => {
	globalThis.calState.responses.push({ status: 500, body: {} }, ok([home]));
	state.startCalendarState();
	await settle();
	assert.equal(state.getCalendarSnapshot().state, "error");
	state.retryCalendars();
	assert.equal(state.getCalendarSnapshot().state, "loading");
	await settle();
	assert.equal(state.getCalendarSnapshot().state, "ready");
});

test("toggling a calendar updates the snapshot and the stored list", async () => {
	globalThis.calState.responses.push(ok([home, work]));
	state.startCalendarState();
	await settle();
	state.toggleCalendar("cal:work");
	assert.deepEqual(state.getCalendarSnapshot().hidden, ["cal:work"]);
	assert.equal(globalThis.calState.storage.get("mailflare.calendar.hidden"), '["cal:work"]');
	state.toggleCalendar("cal:work");
	assert.deepEqual(state.getCalendarSnapshot().hidden, []);
});

test("a change refreshes the list without blanking it, bumps the revision and closes the dialog; a deleted calendar is unhidden", async () => {
	globalThis.calState.responses.push(ok([home, work]), ok([home]));
	state.startCalendarState();
	await settle();
	state.toggleCalendar("cal:work");
	state.openCalendarSettings(work);
	assert.equal(state.getCalendarSnapshot().settings, work);
	const seen = [];
	const unsubscribe = state.subscribeCalendars(() => seen.push(state.getCalendarSnapshot().state));
	state.calendarChanged("deleted", "cal:work");
	assert.equal(state.getCalendarSnapshot().settings, null);
	assert.equal(state.getCalendarSnapshot().revision, 1);
	assert.deepEqual(state.getCalendarSnapshot().hidden, []);
	await settle();
	unsubscribe();
	assert.ok(seen.every((value) => value === "ready"), `the list went through ${seen.join(",")}`);
	assert.deepEqual(state.getCalendarSnapshot().calendars.map((calendar) => calendar.id), ["cal:u1"]);
});

test("a failed refresh keeps the list that is on screen", async () => {
	globalThis.calState.responses.push(ok([home, work]), { status: 500, body: {} });
	state.startCalendarState();
	await settle();
	state.calendarChanged("updated", "cal:work");
	await settle();
	assert.deepEqual([state.getCalendarSnapshot().state, state.getCalendarSnapshot().calendars.length], ["ready", 2]);
});

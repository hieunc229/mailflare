import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.roomsUi2 = { en, fetched: [] };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.roomsUi2.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/time/utils": 'export function formatUserDate(value,options){return new Intl.DateTimeFormat("en-US",{...options,timeZone:"UTC"}).format(new Date(value))} export const zonedDateFields=()=>{throw new Error("unused")}; export const dateFromZonedFields=zonedDateFields;',
	"@/lib/auth/client": "export async function authFetch(url,init){globalThis.roomsUi2.fetched.push([url,init]);return Response.json({results:{}})}",
};
const picker = await loadFixture({ name: "rooms-picker", entryPoint: "src/app/(calendar)/calendar/rooms-picker.tsx", mocks });
const list = await loadFixture({ name: "rooms-list", entryPoint: "src/app/(calendar)/calendar/room-list.tsx", mocks: { ...mocks, "./room-state": "export const retryRooms=()=>{};export const toggleRoom=()=>{};export const useRoomState=()=>({rooms:[],state:'ready',shown:[]})" } });
const utils = await loadFixture({ name: "rooms-ui-utils", entryPoint: "src/app/(calendar)/calendar/room-utils.ts", mocks: {} });
const listUtils = await loadFixture({ name: "rooms-ui-list-utils", entryPoint: "src/app/(calendar)/calendar/calendar-list-utils.ts", mocks: {} });
const view = await loadFixture({ name: "rooms-ui-avail", entryPoint: "src/app/(calendar)/calendar/availability-view.tsx", mocks });
const api = await loadFixture({ name: "rooms-ui-api", entryPoint: "src/app/(calendar)/calendar/availability-api.ts", mocks });
const { RoomsPicker } = await picker.import();
const { RoomListView } = await list.import();
const { toggleShownRoom, activeShownRooms, roomScheduleEvents, roomSaveErrorKey, MAX_SHOWN_ROOMS, MAX_EVENT_ROOMS } = await utils.import();
const { visibleCalendarEvents } = await listUtils.import();
const { AvailabilityView } = await view.import();
const { fetchAvailability } = await api.import();
after(() => { delete globalThis.roomsUi2; for (const fixture of [picker, list, utils, listUtils, view, api]) fixture.dispose(); });

const rooms = [{ id: "r1", name: "Boardroom", kind: "room", capacity: 12, location: "2nd floor" }, { id: "r2", name: "Annex", kind: "room", capacity: null, location: "" }];
const noop = () => {};
const pick = (props) => renderToStaticMarkup(createElement(RoomsPicker, { rooms, state: "ready", canBook: true, selected: [], saved: [], onAdd: noop, onRemove: noop, onRetry: noop, ...props }));

test("the picker offers a room to add while some are not chosen, and not once all are", () => {
	assert.match(pick({ selected: ["r2"] }), /role="combobox"[^>]*aria-label="Add a room"|aria-label="Add a room"[^>]*role="combobox"/);
	assert.doesNotMatch(pick({ selected: ["r1", "r2"] }), /role="combobox"/);
});

test("nothing shows while no room exists and none is chosen", () => {
	assert.equal(pick({ rooms: [] }), "");
	assert.notEqual(pick({ rooms: [], selected: ["r1"] }), "");
});

test("a saved accepted room says Booked, a declined one says so in words with its first clashing date, and each chip can be removed by name", () => {
	const html = pick({ selected: ["r1", "r2"], saved: [{ resourceId: "r1", status: "accepted", conflictAt: null }, { resourceId: "r2", status: "declined", conflictAt: "2030-03-04T09:00:00.000Z" }] });
	assert.match(html, /Boardroom<\/span><span[^>]*>Booked</);
	assert.match(html, /Annex<\/span><span[^>]*>Declined: taken on Mar 4, 2030</);
	assert.match(html, /aria-label="Remove Boardroom"/);
	assert.match(html, /aria-label="Remove Annex"/);
	assert.match(pick({ selected: ["r2"], saved: [{ resourceId: "r2", status: "declined", conflictAt: null }] }), /Declined: not free/);
});

test("a room chosen just now has no status; a room that no longer exists is still shown and removable", () => {
	const fresh = pick({ selected: ["r1"] });
	assert.doesNotMatch(fresh, /Booked|Declined/);
	const gone = pick({ selected: ["gone"] });
	assert.match(gone, /A room that no longer exists/);
	assert.match(gone, /aria-label="Remove A room that no longer exists"/);
});

test("without a Team licence the add control is disabled and says why; at five rooms it says the limit", () => {
	const lapsed = pick({ canBook: false });
	assert.match(lapsed, /<button[^>]*role="combobox"[^>]*disabled/);
	assert.match(lapsed, /Booking rooms needs a Team licence\./);
	assert.equal(MAX_EVENT_ROOMS, 5);
	assert.match(pick({ selected: ["a", "b", "c", "d", "e"] }), /An event can have up to 5 rooms\./);
	assert.doesNotMatch(pick(), /needs a Team licence/);
});

test("loading is announced and a failed list is an alert with a retry; saving is not blocked by either", () => {
	assert.match(pick({ state: "loading", rooms: [] }), /role="status"[^>]*>Loading rooms\.\.\./);
	const failed = pick({ state: "error", rooms: [] });
	assert.match(failed, /role="alert"/);
	assert.match(failed, /Rooms could not be loaded\./);
	assert.match(failed, /Try again/);
});

test("the sidebar section lists each room with a labelled checkbox and shows nothing until there are rooms: not while loading, not when it failed", () => {
	const render = (props) => renderToStaticMarkup(createElement(RoomListView, { rooms, state: "ready", shown: ["r1"], onToggle: noop, ...props }));
	const html = render();
	assert.match(html, /<input[^>]*type="checkbox"[^>]*aria-label="Show Boardroom"[^>]*checked=""|<input[^>]*type="checkbox"[^>]*checked=""[^>]*aria-label="Show Boardroom"/);
	assert.match(html, /aria-label="Show Annex"/);
	assert.doesNotMatch(html, /aria-label="Show Annex"[^>]*checked/);
	for (const props of [{ rooms: [] }, { rooms: [], state: "error" }, { rooms: [], state: "loading" }, { state: "loading" }, { state: "error" }]) assert.equal(render(props), "");
});

test("schedules on are remembered up to 20, and a room that no longer exists drops out", () => {
	assert.deepEqual(toggleShownRoom(["a"], "b"), ["a", "b"]);
	assert.deepEqual(toggleShownRoom(["a", "b"], "a"), ["b"]);
	const many = Array.from({ length: MAX_SHOWN_ROOMS }, (_, index) => `x${index}`);
	assert.deepEqual(toggleShownRoom(many, "new").slice(-1), ["new"]);
	assert.equal(toggleShownRoom(many, "new").length, MAX_SHOWN_ROOMS);
	assert.deepEqual(activeShownRooms(["r1", "gone", "r2"], rooms), ["r1", "r2"]);
});

test("a room's bookings become read-only calendar events named after the room; hidden ones say Busy; events already on the viewer's calendar are not drawn twice", () => {
	const row = (id, extra = {}) => ({ id, resourceId: "r1", title: `T ${id}`, startsAt: "2030-01-07T09:00:00.000Z", endsAt: "2030-01-07T10:00:00.000Z", repeat: "none", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: null, excludedOccurrences: "[]", timeZone: "UTC", allDay: false, davObjectId: null, recurrenceId: null, color: null, redacted: false, ...extra });
	const events = roomScheduleEvents([row("a"), row("b", { redacted: true, title: "Busy" }), row("own")], rooms, new Set(["own"]), "Busy");
	assert.deepEqual(events.map((event) => [event.id, event.title, event.role, event.roomId]), [["room:r1:a", "Boardroom: T a", "freebusy", "r1"], ["room:r1:b", "Boardroom: Busy", "freebusy", "r1"]]);
	assert.equal(events[1].redacted, true);
	assert.equal(events[0].calendarId, undefined);
});

test("hiding a calendar does not hide a room's bookings", () => {
	const events = [{ id: "mine", calendarId: "cal:a" }, { id: "room:r1:x", roomId: "r1" }];
	assert.deepEqual(visibleCalendarEvents(events, ["cal:a"], "cal:default").map((event) => event.id), ["room:r1:x"]);
});

test("a refused room booking has its own translated message", () => {
	assert.equal(roomSaveErrorKey(403, "TEAM_REQUIRED"), "calendar.rooms.error.team");
	assert.equal(roomSaveErrorKey(400, "ROOM_UNKNOWN"), "calendar.rooms.error.invalid");
	assert.equal(roomSaveErrorKey(500), null);
});

test("an availability row for a room is called by the room's name, not its id", () => {
	const html = renderToStaticMarkup(createElement(AvailabilityView, {
		zone: "UTC", guestCount: 1, truncated: false, state: "ready", dayStart: new Date(Date.UTC(2030, 0, 9)), dayEnd: new Date(Date.UTC(2030, 0, 10)), event: { start: new Date(Date.UTC(2030, 0, 9, 9)), end: new Date(Date.UTC(2030, 0, 9, 10)) },
		rows: [{ address: "res_123", label: "Boardroom", availability: { status: "ok", busy: [["2030-01-09T09:30:00.000Z", "2030-01-09T10:30:00.000Z"]] } }],
		find: { state: "idle", slots: [] }, canFind: true, onRetry: noop, onFind: noop, onPick: noop,
	}));
	assert.match(html, />Boardroom</);
	assert.match(html, /Boardroom: busy/);
	assert.doesNotMatch(html, /res_123/);
});

test("the availability request carries the rooms by id, only when there are some", async () => {
	globalThis.roomsUi2.fetched.length = 0;
	await fetchAvailability(["a@x.test"], new Date(0), new Date(86_400_000), "evt", ["r1"]);
	await fetchAvailability(["a@x.test"], new Date(0), new Date(86_400_000));
	const [first, second] = globalThis.roomsUi2.fetched.map(([, init]) => JSON.parse(init.body));
	assert.deepEqual(first.resourceIds, ["r1"]);
	assert.equal("resourceIds" in second, false);
});

test("the editor wires the picker, the room rows and the sidebar", () => {
	const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
	const page = read("src/app/(calendar)/calendar/page.tsx");
	assert.match(page, /<RoomsPicker /);
	assert.match(page, /resourceIds: roomIds/);
	assert.match(page, /<AvailabilityRoomsContext\.Provider value=\{roomRows\}>/);
	assert.match(page, /&resourceIds=\$\{encodeURIComponent\(shownRoomsKey\)\}/);
	assert.match(read("src/app/(calendar)/upcoming-sidebar.tsx"), /<RoomList \/>/);
});

test("an unconfirmed room has its own message, distinct from a declined one", () => {
	const page = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");
	assert.match(page, /room\.status === "unconfirmed" \? t\("calendar\.rooms\.unconfirmedToast"/);
	assert.match(en["calendar.rooms.unconfirmedToast"], /save it again/);
	assert.doesNotMatch(en["calendar.rooms.unconfirmedToast"], /declined|not free/i);
});

test("an occurrence of a series shows its rooms read-only with a note: no add, no remove", () => {
	const html = pick({ selected: ["r1"], saved: [{ resourceId: "r1", status: "accepted", conflictAt: null }], readOnly: true });
	assert.match(html, /Boardroom/);
	assert.match(html, /Booked/);
	assert.doesNotMatch(html, /role="combobox"/);
	assert.doesNotMatch(html, /aria-label="Remove /);
	assert.match(html, /Rooms belong to the whole series/);
	assert.doesNotMatch(pick({ selected: ["r1"] }), /Rooms belong to the whole series/);
});

test("the editor makes the picker read-only for an occurrence and then does not send rooms", () => {
	const page = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");
	assert.match(page, /const roomsLocked = /);
	assert.match(page, /readOnly=\{roomsLocked\}/);
	assert.match(page, /!roomsLocked && \(roomStore\.rooms\.length > 0 \|\| roomIds\.length > 0\) \? \{ resourceIds: roomIds \}/);
});

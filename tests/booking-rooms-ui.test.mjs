import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const en = read("src/lib/i18n/en.json");
globalThis.bookRoomsUi = { en };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.bookRoomsUi.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/time/utils": 'export function formatUserDate(value){return String(value)} export const isValidTimeZone=()=>true; export const zonedDateFields=()=>{throw new Error("unused")}; export const dateFromZonedFields=()=>{throw new Error("unused")}; export const getUserTimeZone=()=>"UTC"',
};
const editor = await loadFixture({ name: "booking-rooms-editor", entryPoint: "src/app/(calendar)/booking/booking-editor.tsx", mocks });
const utils = await loadFixture({ name: "booking-rooms-utils", entryPoint: "src/app/(calendar)/booking/utils.ts", mocks: {} });
const { BookingEditor } = await editor.import();
const { emptyBookingForm, formFromEvent, bookingSaveErrorKey } = await utils.import();
after(() => { delete globalThis.bookRoomsUi; editor.dispose(); utils.dispose(); });

const rooms = [{ id: "r1", name: "Boardroom", kind: "room", capacity: 12, location: "2nd floor" }, { id: "r2", name: "Annex", kind: "room", capacity: null, location: "" }];
const noop = () => {};
const form = (extra = {}) => ({ ...emptyBookingForm("UTC", "h1"), name: "Intro", slug: "intro", ...extra });
const render = (props = {}) => renderToStaticMarkup(createElement(BookingEditor, {
	form: form(), open: true, editingId: "book_1", username: "hana", hosts: [{ id: "h1", name: "Hana", email: "h@x.test" }], canManageHosts: false, currentUserId: "h1", saving: false,
	roomStore: { rooms: rooms.map((room) => ({ ...room, state: "available" })), canBook: true, state: "ready" }, onRetryRooms: noop, onChange: noop, onClose: noop, onSave: noop, onDelete: noop, onToggleEnabled: noop, onClosed: noop, ...props,
}));

test("a new form has no rooms, and an event type's saved list becomes the form's", () => {
	assert.deepEqual(emptyBookingForm("UTC", "h1").resourceIds, []);
	const base = { id: "b", userId: "h1", name: "Intro", slug: "intro", description: "", color: "#2563eb", hostIds: "[]", durationMinutes: 30, location: "", weekdays: "[1]", startTime: "09:00", endTime: "17:00", timeRanges: "[]", timeZone: "UTC", enabled: true };
	assert.deepEqual(formFromEvent({ ...base, resourceIds: '["r1","r2"]' }).resourceIds, ["r1", "r2"]);
	assert.deepEqual(formFromEvent(base).resourceIds, [], "a default event that was never saved");
	assert.deepEqual(formFromEvent({ ...base, resourceIds: "not json" }).resourceIds, []);
});

test("the editor has a Rooms section when rooms exist, summarised as none until one is chosen", () => {
	const html = render();
	assert.match(html, /<span>Rooms<\/span>/);
	assert.match(html, /No rooms/);
	assert.match(html, /aria-expanded="false"[^>]*>[^<]*<span>Rooms<\/span>/);
});

test("chosen rooms are listed by name; a room that no longer exists is said so rather than hidden", () => {
	assert.match(render({ form: form({ resourceIds: ["r1", "r2"] }) }), /Reserves Boardroom, Annex/);
	assert.match(render({ form: form({ resourceIds: ["gone"] }), roomStore: { rooms: [], canBook: true, state: "ready" } }), /Reserves A room that no longer exists/);
});

test("while the room list is loading or failed, a chosen room is not called deleted", () => {
	for (const state of ["loading", "error"]) {
		const html = render({ form: form({ resourceIds: ["r1"] }), roomStore: { rooms: [], canBook: false, state } });
		assert.doesNotMatch(html, /no longer exists/, state);
		assert.doesNotMatch(html, /turned off or deleted/, state);
		assert.match(html, state === "error" ? /Rooms could not be loaded/ : /Loading rooms/, state);
	}
});

const withState = (state) => rooms.map((room) => ({ ...room, state }));
const described = (html) => { const id = /aria-describedby="([^"]+)"/.exec(html)?.[1]; return id && new RegExp(`<p id="${id.replace(/:/g, ":")}"[^>]*>(?:<svg.*?</svg>)?([^<]*)</p>`).exec(html)?.[1]; };

test("a chosen room that is turned off or deleted is explained in text the Rooms heading is described by (not a standing alert)", () => {
	const html = render({ form: form({ resourceIds: ["r1", "gone"] }) });
	assert.match(described(html) ?? "", /A room here is turned off or deleted/);
	assert.doesNotMatch(html, /role="alert"/);
	assert.equal(described(render({ form: form({ resourceIds: ["r1"] }) })), undefined);
});

test("a room that is off is labelled turned off, one closed to public pages says so, only a deleted one is called removed", () => {
	const html = render({ form: form({ resourceIds: ["r1", "r2", "gone"] }), roomStore: { rooms: [{ ...rooms[0], state: "off" }, { ...rooms[1], state: "private" }], canBook: true, state: "ready" } });
	assert.match(html, /Boardroom \(turned off\)/);
	assert.match(html, /Annex \(not open to public booking pages\)/);
	assert.match(html, /A room that no longer exists/);
	assert.match(described(html) ?? "", /turned off or deleted/);
});

test("rooms closed to public booking pages are not offered, and warn when already chosen", () => {
	const html = render({ form: form({ resourceIds: ["r1"] }), roomStore: { rooms: withState("private"), canBook: true, state: "ready" } });
	assert.match(described(html) ?? "", /no longer open to public booking pages/);
});

test("rooms chosen without a Team licence are explained too", () => {
	assert.match(described(render({ form: form({ resourceIds: ["r1"] }), roomStore: { rooms: withState("available"), canBook: false, state: "ready" } })) ?? "", /Booking rooms needs a Team licence/);
});

test("with no room in the installation and none chosen the section is absent", () => {
	assert.doesNotMatch(render({ roomStore: { rooms: [], canBook: false, state: "ready" } }), /<span>Rooms<\/span>/);
});

test("a failed room list shows the section so it can be retried", () => {
	assert.match(render({ roomStore: { rooms: [], canBook: false, state: "error" } }), /<span>Rooms<\/span>/);
});

const catalogs = [["en", en], ...readdirSync(new URL("../public/locales", import.meta.url)).filter((file) => file.endsWith(".json")).map((file) => [file, read(`public/locales/${file}`)])];
const KEYS = ["booking.editor.rooms", "booking.editor.roomsHint", "booking.editor.roomsNone", "booking.editor.roomsSummary", "booking.editor.roomsLoading", "booking.editor.roomsOff", "booking.editor.roomsNeedTeam", "calendar.rooms.notLoaded", "booking.editor.roomTurnedOff", "booking.editor.roomNotPublic", "booking.editor.roomsPrivate", "booking.editor.statusOff", "booking.editor.statusPrivate", "booking.error.roomsSingleHost"];

test("every catalog (34) carries the booking rooms strings, in English, with the same placeholders", () => {
	assert.equal(catalogs.length, 34);
	for (const [name, catalog] of catalogs) for (const key of KEYS) {
		assert.equal(typeof catalog[key], "string", `${name}: ${key}`);
		assert.equal(catalog[key], en[key], `${name}: ${key} is English until translated`);
	}
});

test("a refused save is explained by a translated message chosen from the server's code, not the server's English", () => {
	assert.equal(bookingSaveErrorKey("ROOMS_SINGLE_HOST_ONLY"), "booking.error.roomsSingleHost");
	assert.equal(bookingSaveErrorKey("something else"), null);
	assert.equal(bookingSaveErrorKey(undefined), null);
	assert.match(en["booking.error.roomsSingleHost"], /one host/);
});

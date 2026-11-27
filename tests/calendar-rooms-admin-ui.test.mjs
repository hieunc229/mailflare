import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.roomsUi = { en };
const mocks = { "@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.roomsUi.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}" };
const view = await loadFixture({ name: "rooms-view", entryPoint: "src/app/(admin)/rooms/rooms-view.tsx", mocks });
const dialog = await loadFixture({ name: "rooms-dialog", entryPoint: "src/app/(admin)/rooms/room-dialog.tsx", mocks });
const utils = await loadFixture({ name: "rooms-utils", entryPoint: "src/app/(admin)/rooms/utils.ts", mocks: {} });
const { RoomsView } = await view.import();
const { RoomFields } = await dialog.import();
const { parseCapacity, roomBody, roomErrorKey, NEW_ROOM_FORM } = await utils.import();
after(() => { delete globalThis.roomsUi; view.dispose(); dialog.dispose(); utils.dispose(); });

const room = { id: "r1", name: "Boardroom", kind: "room", capacity: 12, location: "2nd floor", description: "", disabled: false };
const noop = () => {};
const render = (props) => renderToStaticMarkup(createElement(RoomsView, { state: "ready", rooms: [room], available: true, notice: "", deleting: false, onAdd: noop, onEdit: noop, onDelete: noop, onRetry: noop, ...props }));

test("a room shows its name, type, location and seats, with named edit and delete buttons", () => {
	const html = render();
	assert.match(html, /Boardroom/);
	assert.match(html, /2nd floor · Seats 12/);
	assert.match(html, /aria-label="Edit Boardroom"/);
	assert.match(html, /aria-label="Delete Boardroom"/);
	assert.match(html, /aria-label="Edit Boardroom"[^>]*|class="[^"]*min-h-11[^"]*"[^>]*aria-label="Edit Boardroom"/, "touch-sized");
	assert.doesNotMatch(html, /Turned off/);
	assert.match(render({ rooms: [{ ...room, disabled: true, kind: "equipment", capacity: null }] }), /Equipment.*Turned off/s);
});

test("an empty list says what to do, loading and failure have their own states", () => {
	const empty = render({ rooms: [] });
	assert.match(empty, /No rooms or resources yet\./);
	assert.match(empty, /book it from the event editor/);
	assert.match(render({ state: "loading", rooms: [] }), /aria-busy="true"/);
	const failed = render({ state: "error", rooms: [] });
	assert.match(failed, /role="alert"/);
	assert.match(failed, /Try again/);
	assert.doesNotMatch(failed, /No rooms or resources yet/);
});

test("without a Team licence adding is disabled and says why; the existing rooms stay editable", () => {
	const html = render({ available: false });
	assert.match(html, /<button[^>]*disabled[^>]*>.*Add room/s);
	assert.match(html, /needs a Team licence/);
	assert.match(html, /aria-label="Edit Boardroom"/);
	assert.doesNotMatch(render({ available: true }), /needs a Team licence/);
	assert.match(render({ state: "loading", rooms: [] }), /<button[^>]*disabled/);
});

test("a failed delete is announced", () => {
	assert.match(render({ notice: "The room could not be deleted." }), /role="alert"[^>]*>The room could not be deleted\./);
});

test("the form labels every field and disables saving until the name and capacity are acceptable", () => {
	const html = renderToStaticMarkup(createElement(RoomFields, { target: "new", saving: false, error: "", onSave: noop, onClose: noop }));
	for (const [id, label] of [["room-name", "Name"], ["room-kind", "Type"], ["room-capacity", "Capacity \\(people\\)"], ["room-location", "Location"], ["room-description", "Notes"], ["room-disabled", "Turned off"]]) assert.match(html, new RegExp(`<label[^>]*for="${id}"[^>]*>${label}</label>`));
	assert.match(html, /<button[^>]*type="submit"[^>]*disabled/);
	const editing = renderToStaticMarkup(createElement(RoomFields, { target: room, saving: false, error: "A room or resource with that name already exists.", onSave: noop, onClose: noop }));
	assert.match(editing, /value="Boardroom"/);
	assert.doesNotMatch(editing, /<button[^>]*type="submit"[^>]*disabled/);
	assert.match(editing, /role="alert"[^>]*>A room or resource with that name already exists\./);
});

test("capacity is empty or a whole number from 1 to 100000; the body is trimmed; every error has its own message", () => {
	assert.deepEqual(["", " 12 ", "0", "1.5", "abc", "100001", "100000"].map(parseCapacity), [null, 12, undefined, undefined, undefined, undefined, 100000]);
	assert.equal(roomBody(NEW_ROOM_FORM), null);
	assert.deepEqual(roomBody({ ...NEW_ROOM_FORM, name: "  Annex ", capacity: "4", location: " Floor 1 " }), { name: "Annex", kind: "room", capacity: 4, location: "Floor 1", description: "", disabled: false });
	assert.equal(roomBody({ ...NEW_ROOM_FORM, name: "x", capacity: "nope" }), null);
	assert.deepEqual([roomErrorKey("save", 409, "NAME_TAKEN"), roomErrorKey("save", 409, "RESOURCE_LIMIT"), roomErrorKey("save", 403, "TEAM_REQUIRED"), roomErrorKey("save", 400), roomErrorKey("delete", 404), roomErrorKey("save", 500), roomErrorKey("delete", 500)],
		["rooms.error.nameTaken", "rooms.error.limit", "rooms.error.team", "rooms.error.invalid", "rooms.error.notFound", "rooms.saveFailed", "rooms.deleteFailed"]);
});

test("the page is reachable: in the admin nav, the title list and the primary-only prefixes", () => {
	const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
	assert.match(read("src/components/admin-nav.tsx"), /href: "\/rooms", labelKey: "admin\.nav\.rooms"/);
	assert.match(read("src/components/admin-page-titles.ts"), /"\/rooms": "admin\.nav\.rooms"/);
	assert.match(read("src/app/(admin)/layout.tsx"), /"\/rooms",/);
	assert.match(read("src/components/route-title-utils.ts"), /\["\/rooms", "admin\.nav\.rooms"\]/);
});

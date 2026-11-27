import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const en = read("src/lib/i18n/en.json");
globalThis.pubRoomsUi = { en };
const mocks = { "@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.pubRoomsUi.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}" };
const view = await loadFixture({ name: "pub-rooms-view", entryPoint: "src/app/(admin)/rooms/rooms-view.tsx", mocks });
const notice = await loadFixture({ name: "pub-rooms-notice", entryPoint: "src/app/(calendar)/booking/page-notice.tsx", mocks });
const utils = await loadFixture({ name: "pub-rooms-utils", entryPoint: "src/app/(calendar)/booking/room-problem.ts", mocks: {} });
const { RoomsView } = await view.import();
const { BookingPageNotice } = await notice.import();
const { bookingRoomsProblem } = await utils.import();
after(() => { delete globalThis.pubRoomsUi; view.dispose(); notice.dispose(); utils.dispose(); });

const room = { id: "r1", name: "Boardroom", kind: "room", capacity: 12, location: "2nd floor", description: "", disabled: false, publicBooking: false };
const noop = () => {};
const render = (props) => renderToStaticMarkup(createElement(RoomsView, { state: "ready", rooms: [room], available: true, notice: "", deleting: false, onAdd: noop, onEdit: noop, onDelete: noop, onRetry: noop, onPublicBooking: noop, ...props }));

test("admin: each room has a labelled switch for public booking pages, off by default and showing its state in words", () => {
	const html = render();
	assert.match(html, /role="switch"[^>]*aria-checked="false"[^>]*aria-label="Bookable from public booking pages: Boardroom"|aria-label="Bookable from public booking pages: Boardroom"[^>]*role="switch"/);
	assert.doesNotMatch(html, /Public booking<\/span>/);
	assert.match(render({ rooms: [{ ...room, publicBooking: true }] }), /aria-checked="true"/);
	assert.match(render({ rooms: [{ ...room, publicBooking: true }] }), /Public booking/);
});

test("admin: without a Team licence the switch cannot be turned on, but can be turned off", () => {
	assert.match(render({ available: false }), /disabled=""[^>]*aria-label="Bookable from public booking pages|aria-label="Bookable from public booking pages[^>]*disabled=""/);
	assert.doesNotMatch(render({ available: false, rooms: [{ ...room, publicBooking: true }] }), /aria-label="Bookable from public booking pages[^>]*disabled=""|disabled=""[^>]*aria-label="Bookable from public booking pages/);
});

const rooms = [{ id: "ok", state: "available" }, { id: "off", state: "off" }, { id: "closed", state: "private" }];
test("the problem with a booking type's rooms: gone or off first, then closed to public pages, then the licence; nothing before the list is known", () => {
	assert.equal(bookingRoomsProblem(["ok"], rooms, true, "ready"), null);
	assert.equal(bookingRoomsProblem([], rooms, false, "ready"), null);
	assert.equal(bookingRoomsProblem(["ok", "off"], rooms, true, "ready"), "off");
	assert.equal(bookingRoomsProblem(["ok", "gone"], rooms, true, "ready"), "off");
	assert.equal(bookingRoomsProblem(["ok", "closed"], rooms, true, "ready"), "private");
	assert.equal(bookingRoomsProblem(["ok"], rooms, false, "ready"), "licence");
	for (const state of ["loading", "error"]) assert.equal(bookingRoomsProblem(["gone"], [], false, state), null);
});

test("the list card says why a booking page offers no times, and says nothing when nothing is wrong", () => {
	assert.equal(renderToStaticMarkup(createElement(BookingPageNotice, { problem: null })), "");
	assert.match(renderToStaticMarkup(createElement(BookingPageNotice, { problem: "off" })), /This page offers no times: a room is turned off or deleted/);
	assert.match(renderToStaticMarkup(createElement(BookingPageNotice, { problem: "private" })), /no longer open to public booking pages/);
	assert.match(renderToStaticMarkup(createElement(BookingPageNotice, { problem: "licence" })), /Team licence/);
	assert.doesNotMatch(renderToStaticMarkup(createElement(BookingPageNotice, { problem: "off" })), /role="alert"/);
});

const KEYS = ["rooms.publicBooking", "rooms.publicBookingBadge", "booking.pageDark.off", "booking.pageDark.private", "booking.pageDark.licence"];
test("every catalog (34) carries the public booking strings, in English", () => {
	const catalogs = [["en", en], ...readdirSync(new URL("../public/locales", import.meta.url)).filter((file) => file.endsWith(".json")).map((file) => [file, read(`public/locales/${file}`)])];
	assert.equal(catalogs.length, 34);
	for (const [name, catalog] of catalogs) for (const key of KEYS) assert.equal(catalog[key], en[key], `${name}: ${key}`);
});

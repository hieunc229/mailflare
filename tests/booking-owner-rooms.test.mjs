import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-8: a booking-page owner attaches rooms to an event type (Team only, D-13), checked like CS-7's event save.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.own.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.own.user}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/calendar/api-auth": "export function calendarAccessError(){return null}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.own.team}}",
	"@/lib/booking/username": "export async function ensureBookingUsername(){return 'hana'}",
};
const collection = await loadFixture({ name: "booking-owner-collection", entryPoint: "src/app/api/booking/route.ts", mocks });
const item = await loadFixture({ name: "booking-owner-item", entryPoint: "src/app/api/booking/[eventId]/route.ts", mocks });
const roomsRoute = await loadFixture({ name: "booking-owner-rooms-list", entryPoint: "src/app/api/booking/rooms/route.ts", mocks });
const { GET, POST } = await collection.import();
const { PATCH } = await item.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.own; collection.dispose(); item.dispose(); roomsRoute.dispose(); });

const body = (extra = {}) => ({ name: "Intro", slug: "intro", description: "", color: "#2563eb", hostIds: [], durationMinutes: 30, location: "", weekdays: [1, 2, 3], timeRanges: [{ startTime: "09:00", endTime: "17:00" }], timeZone: "UTC", enabled: true, ...extra });
const send = (handler, payload, context) => handler(new Request("http://x/api/booking", { method: "POST", body: JSON.stringify(payload) }), context);
const stored = () => sqlite.prepare("SELECT resource_ids FROM booking_events").all().map((row) => row.resource_ids);

function setup({ team = true } = {}) {
	sqlite?.close();
	sqlite = installSqlite("own", { schema, extra: { team, user: { id: "h1", email: "h1@one.test", name: "Hana", role: "user", calendarEnabled: true } } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('h1', 'h1@one.test', 'Hana', 'x', 'user', 1)");
	for (const [id, disabled] of [["r1", 0], ["r2", 0], ["off", 1], ["priv", 0]]) sqlite.exec(`INSERT INTO calendar_resources (id, name, disabled, public_booking, created_at, updated_at) VALUES ('${id}', 'Room ${id}', ${disabled}, ${id === 'priv' ? 0 : 1}, 1, 1)`);
}

test("an owner with a Team licence creates an event type with rooms; the list gives them back", async () => {
	setup();
	const response = await send(POST, body({ resourceIds: ["r1", "r2"] }));
	assert.equal(response.status, 200);
	assert.deepEqual(stored(), ['["r1","r2"]']);
	const { events } = await (await GET(new Request("http://x/api/booking"))).json();
	assert.deepEqual(JSON.parse(events[0].resourceIds), ["r1", "r2"]);
});

test("no rooms named means none, as before", async () => {
	setup();
	assert.equal((await send(POST, body())).status, 200);
	assert.deepEqual(stored(), ["[]"]);
});

test("without a Team licence rooms cannot be newly attached (403); a type with none is unaffected", async () => {
	setup({ team: false });
	const refused = await send(POST, body({ resourceIds: ["r1"] }));
	assert.equal(refused.status, 403);
	assert.deepEqual(stored(), []);
	assert.equal((await send(POST, body())).status, 200);
});

test("a room that does not exist, is turned off, is a sixth or is not a list is refused", async () => {
	setup();
	for (const [rooms, status] of [[["ghost"], 400], [["off"], 400], [["a", "b", "c", "d", "e", "f"], 400], ["r1", 400], [[1], 400]]) {
		const response = await send(POST, body({ resourceIds: rooms }));
		assert.equal(response.status, status, JSON.stringify(rooms));
	}
	assert.deepEqual(stored(), []);
});

test("an edit keeps a room already attached when the licence has lapsed, and can remove it, but cannot add one", async () => {
	setup();
	const created = await (await send(POST, body({ resourceIds: ["r1"] }))).json();
	const context = { params: Promise.resolve({ eventId: created.event.id }) };
	globalThis.own.team = false;
	assert.equal((await send(PATCH, body({ resourceIds: ["r1"], name: "Renamed" }), context)).status, 200, "kept");
	assert.equal((await send(PATCH, body({ resourceIds: ["r1", "r2"] }), context)).status, 403, "not added");
	assert.deepEqual(stored(), ['["r1"]']);
	assert.equal((await send(PATCH, body({ resourceIds: [] }), context)).status, 200, "removed");
	assert.deepEqual(stored(), ["[]"]);
});

test("a save that names no rooms keeps the rooms it had", async () => {
	setup();
	const created = await (await send(POST, body({ resourceIds: ["r2"] }))).json();
	const context = { params: Promise.resolve({ eventId: created.event.id }) };
	assert.equal((await send(PATCH, body({ description: "changed" }), context)).status, 200);
	assert.deepEqual(stored(), ['["r2"]']);
});

test("a room named twice is attached once", async () => {
	setup();
	assert.equal((await send(POST, body({ resourceIds: ["r1", "r1"] }))).status, 200);
	assert.deepEqual(stored(), ['["r1"]']);
});

test("a type whose stored rooms cannot be read is not silently reset by a save that names none; choosing rooms again repairs it", async () => {
	setup();
	const created = await (await send(POST, body({ resourceIds: ["r1"] }))).json();
	const context = { params: Promise.resolve({ eventId: created.event.id }) };
	sqlite.exec("UPDATE booking_events SET resource_ids = 'garbage'");
	for (const payload of [body(), body({ resourceIds: [] })]) {
		const refused = await send(PATCH, payload, context);
		assert.equal(refused.status, 409);
		assert.match((await refused.json()).error, /could not be read/);
	}
	assert.deepEqual(stored(), ["garbage"], "nothing was written");
	assert.equal((await send(PATCH, body({ resourceIds: ["r2"] }), context)).status, 200);
	assert.deepEqual(stored(), ['["r2"]']);
});

test("a room the administrator has not opened to public booking pages cannot be newly attached", async () => {
	setup();
	const refused = await send(POST, body({ resourceIds: ["priv"] }));
	assert.equal(refused.status, 400);
	assert.match((await refused.json()).error, /public booking pages/);
	assert.deepEqual(stored(), []);
});

test("one already attached stays when the switch is turned off, can be removed, and a save naming it again is kept", async () => {
	setup();
	const created = await (await send(POST, body({ resourceIds: ["r1"] }))).json();
	const context = { params: Promise.resolve({ eventId: created.event.id }) };
	sqlite.exec("UPDATE calendar_resources SET public_booking = 0 WHERE id = 'r1'");
	assert.equal((await send(PATCH, body({ resourceIds: ["r1"], name: "Renamed" }), context)).status, 200);
	assert.equal((await send(PATCH, body({ resourceIds: [] }), context)).status, 200);
});

test("the owner's room list shows every room with what it can be used for, so a room that is off is labelled as off", async () => {
	setup();
	sqlite.exec("UPDATE calendar_resources SET location = 'Floor 2'");
	const { GET: rooms } = await roomsRoute.import();
	const { rooms: list, canBook } = await (await rooms(new Request("http://x/api/booking/rooms"))).json();
	assert.equal(canBook, true);
	assert.deepEqual(list.map((room) => [room.id, room.state]).sort(), [["off", "off"], ["priv", "private"], ["r1", "available"], ["r2", "available"]]);
	assert.deepEqual(Object.keys(list[0]).sort(), ["capacity", "id", "kind", "location", "name", "state"]);
});

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
const { GET, POST } = await collection.import();
const { PATCH } = await item.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.own; collection.dispose(); item.dispose(); });

const body = (extra = {}) => ({ name: "Intro", slug: "intro", description: "", color: "#2563eb", hostIds: [], durationMinutes: 30, location: "", weekdays: [1, 2, 3], timeRanges: [{ startTime: "09:00", endTime: "17:00" }], timeZone: "UTC", enabled: true, ...extra });
const send = (handler, payload, context) => handler(new Request("http://x/api/booking", { method: "POST", body: JSON.stringify(payload) }), context);
const stored = () => sqlite.prepare("SELECT resource_ids FROM booking_events").all().map((row) => row.resource_ids);

function setup({ team = true } = {}) {
	sqlite?.close();
	sqlite = installSqlite("own", { schema, extra: { team, user: { id: "h1", email: "h1@one.test", name: "Hana", role: "user", calendarEnabled: true } } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('h1', 'h1@one.test', 'Hana', 'x', 'user', 1)");
	for (const [id, disabled] of [["r1", 0], ["r2", 0], ["off", 1]]) sqlite.exec(`INSERT INTO calendar_resources (id, name, disabled, created_at, updated_at) VALUES ('${id}', 'Room ${id}', ${disabled}, 1, 1)`);
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

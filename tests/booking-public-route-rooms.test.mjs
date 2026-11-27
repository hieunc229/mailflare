import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, mock } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-8: the public booking endpoint with rooms attached: what it reveals, what it refuses, and that a lost room leaves nothing behind.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "booking-public-rooms", entryPoint: "src/app/api/public/booking/[eventId]/route.ts", mocks: {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.pub.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.pub.team}}",
	"@/lib/auth/rate-limit": "export async function allowBookingAttempt(){return globalThis.pub.allow}",
	"@/lib/booking/confirmation": "export async function sendBookingConfirmation(env,input){globalThis.pub.sent.push(input)}",
} });
const { GET, POST } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.pub; fixture.dispose(); mock.timers.reset(); });

const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7); // a Monday
const at = (hours, minutes = 0) => T0 + hours * H + minutes * 60_000;
const secs = (ms) => Math.floor(ms / 1000);

function setup({ team = true, rooms = '["r1"]' } = {}) {
	sqlite?.close();
	sqlite = installSqlite("pub", { schema, extra: { team, allow: true, sent: [] } });
	const db = globalThis.pub.db;
	const run = db.run.bind(db);
	db.run = async (query) => { await run(query); return { meta: { changes: Number(sqlite.prepare("select changes() as c").get().c) } }; };
	let tail = Promise.resolve();
	db.batch = (list) => {
		const next = tail.then(async () => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } });
		tail = next.catch(() => {});
		return next;
	};
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at, time_zone, booking_username) VALUES ('h1', 'h1@one.test', 'Hana Host', 'x', 'user', 1, 'UTC', 'hana'), ('o', 'o@one.test', 'Org', 'x', 'user', 1, 'UTC', null)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, location, created_at, updated_at) VALUES ('r1', 'Boardroom Vault', 'Floor 9', 1, 1)");
	sqlite.exec(`INSERT INTO booking_events (id, user_id, name, slug, host_ids, resource_ids, duration_minutes, weekdays, time_ranges, time_zone, enabled, created_at, updated_at) VALUES ('book_1', 'h1', 'Intro', 'intro', '["h1"]', '${rooms}', 30, '[1,2,3,4,5]', '[{"startTime":"09:00","endTime":"11:00"}]', 'UTC', 1, 1, 1)`);
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: T0 });
}
const params = { params: Promise.resolve({ eventId: "book_1" }) };
const get = () => GET(new Request("http://x/api/public/booking/book_1"), params);
const post = (startsAt = new Date(at(9)).toISOString()) => POST(new Request("http://x/api/public/booking/book_1", { method: "POST", body: JSON.stringify({ name: "Gus Guest", email: "gus@x.test", startsAt }) }), params);
const roomBusy = (start, end) => {
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone) VALUES ('rival', 'o', 'Secret board meeting', ${secs(start)}, ${secs(end)}, 1, 1, 'UTC'); INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('brival', 'r1', 'rival', 'accepted', 1);`);
};
const guestEvents = () => sqlite.prepare("SELECT id FROM calendar_events WHERE title LIKE '% with Gus Guest'").all();

test("the public page shows free slots and does not reveal the rooms, their names or why a slot is gone", async () => {
	setup();
	roomBusy(at(9), at(9, 30));
	const response = await get();
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.ok(body.slots.length > 0);
	assert.ok(!body.slots.some((slot) => slot.time === "09:00" && slot.localDate === "2030-01-07"), "the slot the room is busy for is gone");
	assert.equal("resourceIds" in body.event, false);
	assert.doesNotMatch(JSON.stringify(body), /r1|Boardroom|Vault|Floor 9|Secret|rival|resource/i);
});

test("a booking for a free slot reserves the room and confirms to the visitor", async () => {
	setup();
	const response = await post();
	assert.equal(response.status, 200);
	assert.equal(guestEvents().length, 1);
	assert.deepEqual(sqlite.prepare("SELECT resource_id, status FROM calendar_resource_bookings").all().map((row) => ({ ...row })), [{ resource_id: "r1", status: "accepted" }]);
	assert.equal(globalThis.pub.sent.length, 1);
});

test("only after a successful booking does the visitor's confirmation name the rooms they hold, in the location", async () => {
	setup();
	sqlite.exec("UPDATE booking_events SET location = 'Head office'");
	assert.equal((await post()).status, 200);
	assert.equal(globalThis.pub.sent[0].event.location, "Head office; Boardroom Vault");
	assert.equal("resourceIds" in globalThis.pub.sent[0].event, false);
});

test("a room that is taken between the page and the booking fails with the same answer as a taken time, leaves no event and sends nothing", async () => {
	setup();
	const slot = new Date(at(9)).toISOString();
	roomBusy(at(9), at(9, 30));
	const response = await post(slot);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "That time is no longer available." });
	assert.deepEqual(guestEvents(), []);
	assert.equal(globalThis.pub.sent.length, 0);
});

test("a Team licence that lapsed refuses new bookings with 403 and shows no slots (D-13); an event type with no rooms is unaffected", async () => {
	setup({ team: false });
	assert.deepEqual((await (await get()).json()).slots, []);
	const refused = await post();
	assert.equal(refused.status, 403);
	assert.deepEqual(guestEvents(), []);
	setup({ team: false, rooms: "[]" });
	assert.equal((await post()).status, 200);
});

test("a room that was turned off offers no slots and refuses a booking", async () => {
	setup();
	sqlite.exec("UPDATE calendar_resources SET disabled = 1");
	assert.deepEqual((await (await get()).json()).slots, []);
	assert.equal((await post()).status, 403);
});

test("the booking attempt limit still applies before anything is read", async () => {
	setup();
	globalThis.pub.allow = false;
	assert.equal((await post()).status, 429);
	assert.deepEqual(guestEvents(), []);
});

test("an event type whose stored room list cannot be read is not offered at all: unknown rooms are never treated as no rooms", async () => {
	for (const stored of ["garbage", '["r1","r1"]', '["a","b","c","d","e","f"]', '[1]', '{"0":"r1"}']) {
		setup({ rooms: stored });
		assert.equal((await get()).status, 404, stored);
		assert.equal((await post()).status, 404, stored);
		assert.deepEqual(guestEvents(), []);
	}
});

test("an event type that predates rooms (the default list) is unchanged", async () => {
	setup({ rooms: "[]" });
	assert.equal((await get()).status, 200);
});

test("the public page gets an allowlisted event: what the page draws and its owner id (the page checks it against the URL), nothing else", async () => {
	setup();
	const { event } = await (await get()).json();
	assert.deepEqual(Object.keys(event).sort(), ["color", "description", "durationMinutes", "endTime", "id", "location", "name", "slug", "startTime", "timeRanges", "timeZone", "userId", "weekdays"]);
	for (const hidden of ["hostIds", "resourceIds", "enabled", "createdAt", "updatedAt"]) assert.equal(hidden in event, false, hidden);
});

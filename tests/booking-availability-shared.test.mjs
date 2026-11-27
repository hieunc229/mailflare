import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, mock } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-8: booking availability reads the shared free/busy service (D-9) and counts the rooms attached to the event.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "booking-avail-shared", entryPoint: "src/lib/booking/availability.ts", mocks: {
	"@/db": "export function getDb(){return globalThis.bookShared.db}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.bookShared.team}}",
} });
const { availableBookingSlots } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.bookShared; fixture.dispose(); mock.timers.reset(); });

const DAY = 86_400_000;
const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.UTC(2030, 0, 7); // a Monday, 00:00 UTC
const at = (days, hours = 0, minutes = 0) => T0 + days * DAY + hours * H + minutes * MIN;
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;
const base = { id: "book_1", userId: "h1", hostIds: ["h1"], resourceIds: [], durationMinutes: 30, weekdays: [1, 2, 3, 4, 5], timeRanges: [{ startTime: "09:00", endTime: "11:00" }], timeZone: "UTC" };
const MON = "2030-01-07";
const ALL_DAY = ["09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30"];

function setup({ team = true } = {}) {
	sqlite?.close();
	sqlite = installSqlite("bookShared", { schema, extra: { team } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at, time_zone) VALUES ('h1', 'h1@one.test', 'H1', 'x', 'user', 1, 'UTC'), ('h2', 'h2@one.test', 'H2', 'x', 'user', 1, 'UTC'), ('o', 'o@one.test', 'O', 'x', 'user', 1, 'UTC')");
	for (const [id, disabled] of [["r1", 0], ["r2", 0], ["off", 1]]) sqlite.exec(`INSERT INTO calendar_resources (id, name, disabled, created_at, updated_at) VALUES ('${id}', 'Room ${id}', ${disabled}, 1, 1)`);
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: T0 });
}
function event(user, start, end, extra = {}) {
	const row = { id: `e${++counter}`, title: "Busy", user_id: user, starts_at: secs(start), ends_at: secs(end), created_at: 1, updated_at: 1, repeat: "none", excluded_occurrences: "[]", time_zone: "UTC", ...extra };
	const keys = Object.keys(row);
	sqlite.prepare(`INSERT INTO calendar_events (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
	return row.id;
}
const book = (room, id, status = "accepted") => sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, ?, ?, ?, 1)").run(`b${++counter}`, room, id, status);
const slots = async (event = base, days = 7) => (await availableBookingSlots({}, event, days)).map((slot) => `${slot.localDate}T${slot.time}`);
const times = (list, date) => list.filter((item) => item.startsWith(date)).map((item) => item.slice(11));

test("D-6: an event marked free no longer takes the host's booking slots (was busy before CS-8)", async () => {
	setup();
	event("h1", at(0, 9), at(0, 11), { transparent: 1 });
	assert.deepEqual(times(await slots(), MON), ALL_DAY);
});

test("a repeating event with no zone of its own is read in its owner's zone, as in the calendar view (was UTC before CS-8)", async () => {
	setup();
	sqlite.exec("UPDATE users SET time_zone = 'America/New_York' WHERE id = 'h1'");
	// Friday 09:00 New York, weekly, stored with no zone: 14:00 UTC before the change of 10 March 2030 and 13:00 UTC after it.
	event("h1", Date.UTC(2030, 2, 1, 14), Date.UTC(2030, 2, 1, 15), { repeat: "weekly", time_zone: null });
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: Date.UTC(2030, 2, 4) });
	const list = await slots({ ...base, timeRanges: [{ startTime: "13:00", endTime: "15:00" }] }, 14);
	assert.deepEqual(times(list, "2030-03-08"), ["13:00", "13:15", "13:30"]);
	assert.deepEqual(times(list, "2030-03-15"), ["14:00", "14:15", "14:30"]);
});

test("a room's accepted booking takes the slots the host would otherwise offer", async () => {
	setup();
	book("r1", event("o", at(0, 9, 30), at(0, 10)));
	assert.deepEqual(times(await slots({ ...base, resourceIds: ["r1"] }), MON), ["09:00", "10:00", "10:15", "10:30"]);
	assert.deepEqual(times(await slots(), MON), ALL_DAY, "an event without rooms ignores them");
});

test("every attached room must be free; a declined booking and another room do not count", async () => {
	setup();
	book("r1", event("o", at(0, 9), at(0, 9, 30)));
	book("r2", event("o", at(0, 10), at(0, 10, 30)));
	book("r2", event("o", at(0, 9, 30), at(0, 10), {}), "declined");
	assert.deepEqual(times(await slots({ ...base, resourceIds: ["r1", "r2"] }), MON), ["09:30", "10:30"]);
	assert.deepEqual(times(await slots({ ...base, resourceIds: ["r1"] }), MON), ["09:30", "09:45", "10:00", "10:15", "10:30"]);
});

test("host and room are both read: either one busy removes the slot", async () => {
	setup();
	event("h1", at(0, 9), at(0, 9, 30));
	book("r1", event("o", at(0, 10, 15), at(0, 11)));
	assert.deepEqual(times(await slots({ ...base, resourceIds: ["r1"] }), MON), ["09:30", "09:45"]);
});

test("a room that is turned off, gone, or whose Team licence lapsed offers no slots at all (fails closed)", async () => {
	setup();
	assert.deepEqual(await slots({ ...base, resourceIds: ["off"] }), []);
	assert.deepEqual(await slots({ ...base, resourceIds: ["r1", "ghost"] }), []);
	setup({ team: false });
	assert.deepEqual(await slots({ ...base, resourceIds: ["r1"] }), []);
	assert.ok((await slots(base)).length > 0, "an event with no rooms is unaffected by the licence");
});

test("a room series too heavy to read leaves no slot free", async () => {
	setup();
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: Date.UTC(2100, 5, 1) });
	book("r1", event("o", Date.UTC(2026, 1, 1, 9), Date.UTC(2026, 1, 1, 10), { repeat: "custom", rrule: "FREQ=DAILY;BYMONTH=2;COUNT=5000" }));
	assert.deepEqual(await slots({ ...base, resourceIds: ["r1"] }), []);
});

test("a slot answer carries only the times: nothing about who or what made the room busy", async () => {
	setup();
	book("r1", event("o", at(0, 9), at(0, 9, 30)));
	const result = await availableBookingSlots({}, { ...base, resourceIds: ["r1"] }, 7);
	assert.ok(result.length > 0);
	for (const slot of result) assert.deepEqual(Object.keys(slot).sort(), ["endsAt", "localDate", "startsAt", "time"]);
	assert.doesNotMatch(JSON.stringify(result), /Room r1|r1|Busy|h1|o@one/);
});

test("the sixty-day page the public route asks for fits the shared service's 62-day window", async () => {
	setup();
	event("h1", at(59, 9), at(59, 11));
	const list = await slots(base, 60);
	assert.deepEqual(times(list, "2030-03-08"), [], "an event 59 days out is read");
});

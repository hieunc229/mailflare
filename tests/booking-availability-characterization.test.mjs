import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, mock } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// Pins what booking availability does today (CS-8 step 0): written against the private `repeatsDuring` expander and kept
// passing, except where a test says it changed on purpose, when the shared free/busy service replaced that expander (D-9).
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "booking-avail-char", entryPoint: "src/lib/booking/availability.ts", mocks: { "@/db": "export function getDb(){return globalThis.bookChar.db}" } });
const { availableBookingSlots } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.bookChar; fixture.dispose(); mock.timers.reset(); });

const DAY = 86_400_000;
const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.UTC(2030, 0, 7); // a Monday, 00:00 UTC
const at = (days, hours = 0, minutes = 0) => T0 + days * DAY + hours * H + minutes * MIN;
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;

const base = { id: "book_1", userId: "h1", hostIds: ["h1"], durationMinutes: 30, weekdays: [1, 2, 3, 4, 5], timeRanges: [{ startTime: "09:00", endTime: "11:00" }], timeZone: "UTC" };

function setup() {
	sqlite?.close();
	sqlite = installSqlite("bookChar", { schema });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at, time_zone) VALUES ('h1', 'h1@one.test', 'H1', 'x', 'user', 1, 'UTC'), ('h2', 'h2@one.test', 'H2', 'x', 'user', 1, 'UTC'), ('other', 'o@one.test', 'O', 'x', 'user', 1, 'UTC')");
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: T0 });
}
function event(user, start, end, extra = {}) {
	const row = { id: `e${++counter}`, title: "Busy", user_id: user, starts_at: secs(start), ends_at: secs(end), created_at: 1, updated_at: 1, repeat: "none", excluded_occurrences: "[]", time_zone: "UTC", ...extra };
	const keys = Object.keys(row);
	sqlite.prepare(`INSERT INTO calendar_events (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
	return row.id;
}
const slots = async (event = base, days = 7) => (await availableBookingSlots({}, event, days)).map((slot) => `${slot.localDate}T${slot.time}`);
const times = (list, date) => list.filter((item) => item.startsWith(date)).map((item) => item.slice(11));
const MON = "2030-01-07";
const ALL_DAY = ["09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30"];

test("a free host gets every 15 minute start inside the ranges on the chosen weekdays, none on the weekend", async () => {
	setup();
	const list = await slots();
	assert.deepEqual(times(list, MON), ALL_DAY);
	assert.deepEqual(times(list, "2030-01-12"), []);
	assert.equal(list.length, 5 * ALL_DAY.length);
});

test("slots start at least an hour from now", async () => {
	setup();
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: at(0, 8, 30) });
	assert.deepEqual(times(await slots(), MON), ["09:30", "09:45", "10:00", "10:15", "10:30"]);
});

test("a one-off event removes every slot it overlaps; touching it does not", async () => {
	setup();
	event("h1", at(0, 9, 30), at(0, 10));
	assert.deepEqual(times(await slots(), MON), ["09:00", "10:00", "10:15", "10:30"]);
});

test("another person's events do not matter; events of any host do", async () => {
	setup();
	event("other", at(0, 9), at(0, 11));
	assert.deepEqual(times(await slots(), MON), ALL_DAY);
	event("h2", at(0, 9), at(0, 10));
	assert.deepEqual(times(await slots({ ...base, hostIds: ["h1", "h2"] }), MON), ["10:00", "10:15", "10:30"]);
	assert.deepEqual(times(await slots(), MON), ALL_DAY, "a host not on the event is not asked");
});

test("accepted, tentative and self-made events block; declined, cancelled and not-yet-answered ones do not", async () => {
	for (const [status, blocks] of [[null, true], ["accepted", true], ["tentative", true], ["declined", false], ["cancelled", false], ["needs-action", false]]) {
		setup();
		event("h1", at(0, 9), at(0, 11), { response_status: status });
		assert.equal((await slots()).some((item) => item.startsWith(MON)), !blocks, String(status));
	}
});

test("a weekly series blocks on each of its days, an excluded occurrence is free, an ended series stops", async () => {
	setup();
	event("h1", at(0, 9), at(0, 11), { repeat: "weekly", excluded_occurrences: JSON.stringify([at(7, 9)]), repeat_until: secs(at(15)) });
	const list = await slots(base, 28);
	assert.deepEqual(times(list, MON), []);
	assert.deepEqual(times(list, "2030-01-14"), ALL_DAY, "excluded");
	assert.deepEqual(times(list, "2030-01-21"), []);
	assert.deepEqual(times(list, "2030-01-28"), ALL_DAY, "after repeat_until");
});

test("daily, weekdays and monthly series block; a series that starts later does not block earlier days", async () => {
	setup();
	event("h1", at(1, 9), at(1, 9, 30), { repeat: "daily" });
	event("h1", at(2, 10), at(2, 10, 30), { repeat: "weekdays", repeat_days: "[1,2,3,4,5]" });
	event("h1", at(3, 9, 30), at(3, 10), { repeat: "monthly" });
	const list = await slots(base, 7);
	assert.deepEqual(times(list, MON), ALL_DAY, "no series before its first day");
	assert.deepEqual(times(list, "2030-01-08"), ["09:30", "09:45", "10:00", "10:15", "10:30"], "daily from Tuesday 09:00");
	assert.deepEqual(times(list, "2030-01-09"), ["09:30", "10:30"], "daily plus the weekdays series at 10:00");
	assert.deepEqual(times(list, "2030-01-10"), ["10:30"], "daily, weekdays and the monthly series on the 10th");
});

test("a custom rule is expanded: every other Monday", async () => {
	setup();
	event("h1", at(0, 9), at(0, 11), { repeat: "custom", rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" });
	const list = await slots(base, 21);
	assert.deepEqual(times(list, MON), []);
	assert.deepEqual(times(list, "2030-01-14"), ALL_DAY);
	assert.deepEqual(times(list, "2030-01-21"), []);
});

test("a moved occurrence is its own row: busy at the new time only", async () => {
	setup();
	const master = event("h1", at(0, 9), at(0, 10), { repeat: "weekly", excluded_occurrences: JSON.stringify([at(7, 9)]) });
	event("h1", at(7, 10), at(7, 11), { dav_object_id: master, recurrence_id: secs(at(7, 9)) });
	const list = await slots(base, 14);
	assert.deepEqual(times(list, MON), ["10:00", "10:15", "10:30"]);
	assert.deepEqual(times(list, "2030-01-14"), ["09:00", "09:15", "09:30"]);
});

test("a series with a zone of its own keeps its local time through the summer-time change", async () => {
	setup();
	event("h1", Date.UTC(2030, 2, 1, 14), Date.UTC(2030, 2, 1, 15), { repeat: "weekly", time_zone: "America/New_York" });
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: Date.UTC(2030, 2, 4) });
	// 09:00 New York is 14:00 UTC before the change (10 March 2030) and 13:00 UTC after it.
	const list = await slots({ ...base, timeRanges: [{ startTime: "13:00", endTime: "15:00" }] }, 14);
	assert.deepEqual(times(list, "2030-03-08"), ["13:00", "13:15", "13:30"]);
	assert.deepEqual(times(list, "2030-03-15"), ["14:00", "14:15", "14:30"], "after the change the series sits at 13:00 UTC");
});

test("an all-day event blocks its whole day", async () => {
	setup();
	event("h1", at(0), at(1), { all_day: 1 });
	const list = await slots();
	assert.deepEqual(times(list, MON), []);
	assert.deepEqual(times(list, "2030-01-08"), ALL_DAY);
});

test("an event beyond the window does not block it", async () => {
	setup();
	event("h1", at(30, 9), at(30, 11));
	assert.equal((await slots(base, 14)).length, 10 * ALL_DAY.length);
});

test("a transparent (free) event still blocks a booking slot before CS-8", async () => {
	setup();
	event("h1", at(0, 9), at(0, 11), { transparent: 1 });
	assert.deepEqual(times(await slots(), MON), []);
});

test("a repeating event with no zone of its own is read in UTC before CS-8", async () => {
	setup();
	sqlite.exec("UPDATE users SET time_zone = 'Asia/Kolkata' WHERE id = 'h1'");
	event("h1", at(0, 9), at(0, 11), { repeat: "daily", time_zone: null });
	assert.deepEqual(times(await slots(), MON), []);
});

test("a rule whose walk hits the work budget is busy for the whole window: unknown is never offered as free", async () => {
	setup();
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: Date.UTC(2100, 5, 1) });
	event("h1", Date.UTC(2026, 1, 1, 9), Date.UTC(2026, 1, 1, 10), { repeat: "custom", rrule: "FREQ=DAILY;BYMONTH=2;COUNT=5000" });
	assert.deepEqual(await slots(), []);
	setup();
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: Date.UTC(2100, 5, 1) });
	event("h1", Date.UTC(2026, 1, 1, 9), Date.UTC(2026, 1, 1, 10), { repeat: "custom", rrule: "FREQ=DAILY;BYMONTH=2" });
	assert.ok((await slots()).length > 0, "a rule that walked completely is exact");
});

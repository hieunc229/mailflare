import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");

const fixture = await loadFixture({ name: "cal-rooms-booking", entryPoint: "src/lib/calendar/room-booking.ts", mocks: {} });
const { bookRooms, MAX_CONFLICT_DATES, MAX_ROOM_ATTEMPTS } = await fixture.import();
let sqlite;
let statements = [];
after(() => { sqlite?.close(); delete globalThis.rooms; fixture.dispose(); });

const DAY = 86_400_000;
const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7); // a Monday
const NOW = new Date(Date.UTC(2029, 11, 1));
const at = (days, hours = 0) => T0 + days * DAY + hours * H;
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;

/** A competing write can be injected just before a booking's batch starts (after its reads). */
let beforeBatch = null;

function setup() {
	sqlite?.close();
	statements = [];
	sqlite = installSqlite("rooms", { schema, beforeQuery: (sql) => { statements.push(sql); } });
	// The sqlite-proxy driver has no batch(); D1 runs a batch as one atomic unit, so batches here run one at a time inside a transaction.
	let tail = Promise.resolve();
	globalThis.rooms.db.batch = (list) => {
		const run = tail.then(async () => {
			// Only a booking's compare-and-swap batch has more than the delete and the insert.
			if (list.length > 3) beforeBatch?.(sqlite);
			sqlite.exec("BEGIN");
			try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		});
		tail = run.catch(() => {});
		return run;
	};
	beforeBatch = null;
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	for (const id of ["r1", "r2", "r3"]) sqlite.exec(`INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('${id}', 'Room ${id}', 1, 1)`);
	return globalThis.rooms.db;
}

function event(user, start, end, extra = {}) {
	const row = { id: `e${++counter}`, repeat: "none", repeat_days: "[]", excluded_occurrences: "[]", time_zone: "UTC", ...extra };
	const columns = ["id", "user_id", "title", "starts_at", "ends_at", "created_at", "updated_at", ...Object.keys(row).filter((key) => key !== "id")];
	const values = [row.id, user, "Standup", secs(start), secs(end), 1, 1, ...Object.entries(row).filter(([key]) => key !== "id").map(([, value]) => value)];
	sqlite.prepare(`INSERT INTO calendar_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
	return row.id;
}
const weekly = (user, start, end, extra = {}) => event(user, start, end, { repeat: "weekly", ...extra });
const book = (db, id, rooms, options) => bookRooms(db, id, rooms, { now: NOW, ...options });
const rows = (eventId) => sqlite.prepare("SELECT resource_id, status, conflict_at FROM calendar_resource_bookings WHERE event_id = ? ORDER BY resource_id").all(eventId).map((row) => ({ ...row }));
const statusOf = (eventId, resourceId = "r1") => rows(eventId).find((row) => row.resource_id === resourceId)?.status;

test("a free room is accepted and stored", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	const result = await book(db, a, ["r1"]);
	assert.deepEqual(result.rooms.map((room) => [room.resourceId, room.status, room.occurrences]), [["r1", "accepted", []]]);
	assert.deepEqual(rows(a), [{ resource_id: "r1", status: "accepted", conflict_at: null }]);
});

test("an overlapping event is declined with its first clashing date; back-to-back events do not clash", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	await book(db, a, ["r1"]);
	const back = event("u2", at(0, 10), at(0, 11));
	assert.equal((await book(db, back, ["r1"])).rooms[0].status, "accepted", "touching is not overlapping");
	const clash = event("u2", at(0, 9.5), at(0, 10.5));
	const result = await book(db, clash, ["r1"]);
	assert.equal(result.rooms[0].status, "declined");
	assert.deepEqual(result.rooms[0].occurrences, [new Date(at(0, 9.5)).toISOString()]);
	assert.deepEqual(rows(clash), [{ resource_id: "r1", status: "declined", conflict_at: secs(at(0, 9.5)) }]);
});

test("a weekly series that clashes on one date three months on is declined as a whole, with that date", async () => {
	const db = setup();
	const series = weekly("u1", at(0, 9), at(0, 10));
	assert.equal((await book(db, series, ["r1"])).rooms[0].status, "accepted");
	const oneOff = event("u2", at(91, 9), at(91, 10));
	const result = await book(db, oneOff, ["r1"]);
	assert.equal(result.rooms[0].status, "declined");
	assert.deepEqual(result.rooms[0].occurrences, [new Date(at(91, 9)).toISOString()]);
	// The other way round: a new series against the one-off in three months.
	const second = setup();
	const one = event("u2", at(91, 9), at(91, 10));
	await book(second, one, ["r1"]);
	const wholeSeries = weekly("u1", at(0, 9), at(0, 10));
	const answer = await book(second, wholeSeries, ["r1"]);
	assert.equal(answer.rooms[0].status, "declined", "one clash declines the whole series");
	assert.equal(rows(wholeSeries).length, 1, "one booking row for the series, not one per occurrence");
});

test("at most ten clashing dates are reported", async () => {
	const db = setup();
	const busy = weekly("u1", at(0, 9), at(0, 10));
	await book(db, busy, ["r1"]);
	const other = weekly("u2", at(0, 9.5), at(0, 10.5));
	const result = await book(db, other, ["r1"]);
	assert.equal(MAX_CONFLICT_DATES, 10);
	assert.equal(result.rooms[0].occurrences.length, 10);
	assert.equal(result.rooms[0].occurrences[0], new Date(at(0, 9.5)).toISOString());
});

test("an occurrence of the other series that was excluded does not clash, and a moved occurrence clashes at its new time", async () => {
	const db = setup();
	const series = weekly("u1", at(0, 9), at(0, 10), { excluded_occurrences: JSON.stringify([at(7, 9)]) });
	await book(db, series, ["r1"]);
	const inGap = event("u2", at(7, 9), at(7, 10));
	assert.equal((await book(db, inGap, ["r1"])).rooms[0].status, "accepted", "the excluded week is free");
	// A CalDAV client moved week three to 14:00: the override row is its own row, joined through the series' booking.
	event("u1", at(14, 14), at(14, 15), { dav_object_id: series, recurrence_id: secs(at(14, 9)) });
	sqlite.prepare("UPDATE calendar_events SET excluded_occurrences = ? WHERE id = ?").run(JSON.stringify([at(7, 9), at(14, 9)]), series);
	assert.equal((await book(db, event("u2", at(14, 14.5), at(14, 15.5)), ["r1"])).rooms[0].status, "declined");
	assert.equal((await book(db, event("u2", at(14, 9), at(14, 10)), ["r1"])).rooms[0].status, "accepted", "the old time of the moved occurrence is free");
});

test("a declined booking does not hold the room", async () => {
	const db = setup();
	const first = event("u1", at(0, 9), at(0, 10));
	await book(db, first, ["r1"]);
	const loser = event("u2", at(0, 9), at(0, 10));
	assert.equal((await book(db, loser, ["r1"])).rooms[0].status, "declined");
	const third = event("u2", at(0, 10), at(0, 11));
	assert.equal((await book(db, third, ["r1"])).rooms[0].status, "accepted");
	sqlite.prepare("DELETE FROM calendar_events WHERE id = ?").run(first);
	assert.equal((await book(db, loser, ["r1"])).rooms[0].status, "accepted", "saving again re-checks, and the freed room is taken");
});

test("an event never clashes with its own booking, and a re-timed event re-runs the check", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	const b = event("u2", at(0, 11), at(0, 12));
	await book(db, a, ["r1"]);
	await book(db, b, ["r1"]);
	assert.equal((await book(db, a, ["r1"])).rooms[0].status, "accepted");
	sqlite.prepare("UPDATE calendar_events SET starts_at = ?, ends_at = ? WHERE id = ?").run(secs(at(0, 9.5)), secs(at(0, 11.5)), b);
	assert.equal((await book(db, b, ["r1"])).rooms[0].status, "declined", "moved onto a");
	sqlite.prepare("UPDATE calendar_events SET starts_at = ?, ends_at = ? WHERE id = ?").run(secs(at(0, 11)), secs(at(0, 12)), b);
	assert.equal((await book(db, b, ["r1"])).rooms[0].status, "accepted", "moved back");
	assert.equal(rows(b).length, 1, "one row per event and room");
});

test("naming fewer rooms removes the booking of the ones left out; naming none removes them all; each room is checked on its own", async () => {
	const db = setup();
	const other = event("u2", at(0, 9), at(0, 10));
	await book(db, other, ["r2"]);
	const a = event("u1", at(0, 9), at(0, 10));
	const result = await book(db, a, ["r1", "r2", "r3"]);
	assert.deepEqual(result.rooms.map((room) => [room.resourceId, room.status]), [["r1", "accepted"], ["r2", "declined"], ["r3", "accepted"]]);
	await book(db, a, ["r1"]);
	assert.deepEqual(rows(a).map((row) => row.resource_id), ["r1"]);
	await book(db, a, []);
	assert.deepEqual(rows(a), []);
});

test("deleting the event frees the room", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	await book(db, a, ["r1"]);
	sqlite.prepare("DELETE FROM calendar_events WHERE id = ?").run(a);
	assert.deepEqual(rows(a), []);
	assert.equal((await book(db, event("u2", at(0, 9), at(0, 10)), ["r1"])).rooms[0].status, "accepted");
});

test("two saves for the same slot at once end with exactly one accepted", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	const b = event("u2", at(0, 9, 0), at(0, 10));
	const [first, second] = await Promise.all([book(db, a, ["r1"]), book(db, b, ["r1"])]);
	const statuses = [first.rooms[0].status, second.rooms[0].status].sort();
	assert.deepEqual(statuses, ["accepted", "declined"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_resource_bookings WHERE status = 'accepted'").get().n, 1);
});

test("a competing booking written between this one's read and its write makes the write fail, and the retry sees it", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	const b = event("u2", at(0, 9.5), at(0, 10.5));
	let injected = false;
	beforeBatch = (database) => {
		if (injected) return;
		injected = true;
		// What a winner does in its own batch: bump the room's token and write its accepted booking.
		database.exec(`UPDATE calendar_resources SET booking_token = 'someone-else' WHERE id = 'r1'; INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('crb_x', 'r1', '${a}', 'accepted', 1)`);
	};
	const result = await book(db, b, ["r1"]);
	assert.equal(result.rooms[0].status, "declined", "the retry read the winner's booking");
	assert.equal(statusOf(a), "accepted");
	assert.equal(statusOf(b), "declined");
});

test("when every attempt loses the race the room is not given: the booking is declined, never accepted unchecked", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	let attempts = 0;
	beforeBatch = (database) => { attempts += 1; database.exec(`UPDATE calendar_resources SET booking_token = 'moved-${attempts}' WHERE id = 'r1'`); };
	const result = await book(db, a, ["r1"]);
	assert.equal(attempts, MAX_ROOM_ATTEMPTS);
	assert.equal(result.rooms[0].status, "declined");
	assert.equal(statusOf(a), "declined");
});

test("every statement binds at most 100 parameters, with five rooms and a long series", async () => {
	const db = setup();
	for (const id of ["r4", "r5"]) sqlite.exec(`INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('${id}', 'Room ${id}', 1, 1)`);
	const a = weekly("u1", at(0, 9), at(0, 10));
	statements = [];
	await book(db, a, ["r1", "r2", "r3", "r4", "r5"]);
	assert.ok(statements.length > 0);
	for (const sql of statements) assert.ok((sql.match(/\?/g) ?? []).length <= 100, sql);
});

test("only the first 366 days are checked: a daily series is accepted though the room is taken 400 days out", async () => {
	const db = setup();
	const farOff = event("u2", at(400, 9), at(400, 10));
	await book(db, farOff, ["r1"]);
	const daily = event("u1", at(0, 9), at(0, 10), { repeat: "daily" });
	assert.equal((await book(db, daily, ["r1"])).rooms[0].status, "accepted", "400 days out is past the horizon");
	const near = event("u2", at(300, 9), at(300, 10));
	await book(db, near, ["r2"]);
	assert.equal((await book(db, daily, ["r2"])).rooms[0].status, "declined", "300 days out is inside it");
});

test("an event in the past is not checked", async () => {
	const db = setup();
	const old = event("u1", Date.UTC(2020, 0, 6, 9), Date.UTC(2020, 0, 6, 10));
	assert.equal((await book(db, old, ["r1"])).rooms[0].status, "accepted");
	const same = event("u2", Date.UTC(2020, 0, 6, 9), Date.UTC(2020, 0, 6, 10));
	assert.equal((await book(db, same, ["r1"])).rooms[0].status, "accepted");
});

test("a booking is refused for an event that is not there", async () => {
	const db = setup();
	await assert.rejects(() => book(db, "missing", ["r1"]), /not found/i);
});

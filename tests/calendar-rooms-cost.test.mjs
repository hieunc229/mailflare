import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// I-3: what one booking attempt costs, in statements and in expansion work.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "cal-rooms-cost", entryPoint: "src/lib/calendar/room-booking.ts", mocks: {} });
const { bookRooms } = await fixture.import();
let sqlite;
let statements = [];
let batches = [];
after(() => { sqlite?.close(); delete globalThis.roomCost; fixture.dispose(); });

const DAY = 86_400_000;
const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7);
const NOW = new Date(Date.UTC(2029, 11, 1));
const at = (days, hours = 0) => T0 + days * DAY + hours * H;
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;

function setup({ atomic = true } = {}) {
	sqlite?.close();
	statements = [];
	batches = [];
	sqlite = installSqlite("roomCost", { schema, beforeQuery: (sql) => { statements.push(sql); } });
	const db = globalThis.roomCost.db;
	if (!atomic) db.batchIsAtomic = false;
	db.batch = async (list) => { batches.push(list.length); sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	for (const id of ["r1", "r2", "r3", "r4", "r5"]) sqlite.exec(`INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('${id}', 'Room ${id}', 1, 1)`);
	return db;
}
function event(start, end, extra = {}) {
	const id = `e${++counter}`;
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, time_zone, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?, ?, 'UTC', 1, 1)").run(id, secs(start), secs(end), extra.repeat ?? "none");
	return id;
}
const accept = (room, id) => sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, ?, ?, 'accepted', 1)").run(`b_${room}_${id}`, room, id);
const reads = () => statements.filter((sql) => /^select/i.test(sql)).length;

const taken = (rooms) => { for (const room of rooms) accept(room, event(at(0, 9), at(0, 10))); };

test("a five-room booking: only the rooms that end up accepted get a guard, and an atomic driver does not re-read afterwards", async () => {
	const db = setup();
	taken(["r1", "r2"]);
	const mine = event(at(0, 9), at(0, 10));
	statements = []; batches = [];
	const result = await bookRooms(db, mine, ["r1", "r2", "r3", "r4", "r5"], { now: NOW });
	assert.deepEqual(result.rooms.map((room) => room.status), ["declined", "declined", "accepted", "accepted", "accepted"]);
	assert.deepEqual(batches, [3 * 3 + 2], "three guards of three statements, then the delete and the insert (was 17)");
	assert.equal(reads(), 4, "event, its moved occurrences, the room tokens, the other bookings: no re-read (was 5)");
});

test("a booking that ends up declined everywhere writes no guard at all", async () => {
	const db = setup();
	taken(["r1", "r2"]);
	const mine = event(at(0, 9), at(0, 10));
	statements = []; batches = [];
	await bookRooms(db, mine, ["r1", "r2"], { now: NOW });
	assert.deepEqual(batches, [2]);
});

test("a driver whose batches are not atomic re-reads once after writing", async () => {
	const db = setup({ atomic: false });
	taken(["r1"]);
	const mine = event(at(0, 9), at(0, 10));
	statements = []; batches = [];
	await bookRooms(db, mine, ["r1", "r2", "r3"], { now: NOW });
	assert.equal(reads(), 5);
});

test("the work budget is one total per save, shared by its rooms: five busy rooms get a fifth each", async () => {
	const db = setup();
	const daily = (hour) => event(at(0, hour), at(0, hour + 0.5), { repeat: "daily" });
	// Each room carries 12 daily series at other hours: about 4400 units of work each, 22000 for five rooms.
	for (const room of ["r1", "r2", "r3", "r4", "r5"]) for (let index = 0; index < 12; index += 1) accept(room, daily(11 + index));
	const mine = event(at(0, 9), at(0, 9.5), { repeat: "daily" });
	const one = await bookRooms(db, mine, ["r1"], { now: NOW });
	assert.equal(one.rooms[0].status, "accepted", "one room may spend the whole budget");
	const five = await bookRooms(db, mine, ["r1", "r2", "r3", "r4", "r5"], { now: NOW });
	assert.deepEqual(five.rooms.map((room) => room.status), Array(5).fill("declined"), "five rooms share it, so none could be read in full");
});

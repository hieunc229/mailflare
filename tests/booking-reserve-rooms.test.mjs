import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-8: a visitor's booking reserves the event type's rooms through CS-7's bookRooms, and fails whole when a room is lost.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "booking-reserve", entryPoint: "src/lib/booking/reserve.ts", mocks: {
	"@/db": "export function getDb(){return globalThis.reserve.db}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:true}}",
} });
const { reserveBooking } = await fixture.import();
let sqlite;
let beforeBatch = null;
let betweenStatements = null;
let crashAt = -1;
after(() => { sqlite?.close(); delete globalThis.reserve; fixture.dispose(); });

const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7);
const at = (hours, minutes = 0) => T0 + hours * H + minutes * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;
const type = { id: "book_1", userId: "h1", name: "Intro", hostIds: ["h1"], resourceIds: ["r1"], location: "", color: "blue", timeZone: "UTC" };

function setup() {
	sqlite?.close();
	sqlite = installSqlite("reserve", { schema });
	const db = globalThis.reserve.db;
	const run = db.run.bind(db);
	// The booking insert reads a D1-style result; the node driver reports the number of rows the last statement changed.
	db.run = async (query) => { await run(query); return { meta: { changes: Number(sqlite.prepare("select changes() as c").get().c) } }; };
	let tail = Promise.resolve();
	db.batch = (list) => {
		const next = tail.then(async () => {
			// The room-and-event batch is the only one with more than three statements.
			if (list.length > 3) beforeBatch?.(sqlite);
			if (db.batchIsAtomic === false) {
				// No transaction (Neon over HTTP): each statement stands alone, and a failure leaves the earlier ones written.
				for (const [index, statement] of list.entries()) { if (list.length > 3) betweenStatements?.(index, sqlite); if (crashAt === index) throw new Error("process died"); await statement; }
				return;
			}
			sqlite.exec("BEGIN");
			try { for (const [index, statement] of list.entries()) { if (list.length > 3 && crashAt === index) throw new Error("process died"); await statement; } sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		});
		tail = next.catch(() => {});
		return next;
	};
	beforeBatch = null;
	betweenStatements = null;
	crashAt = -1;
	for (const id of ["h1", "h2", "o"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	for (const id of ["r1", "r2"]) sqlite.exec(`INSERT INTO calendar_resources (id, name, public_booking, created_at, updated_at) VALUES ('${id}', 'Room ${id}', 1, 1, 1)`);
}
function rival(room, start, end, extra = {}) {
	const id = `rival${++counter}`;
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone, transparent) VALUES (?, 'o', 'Board', ?, ?, 1, 1, 'UTC', ?)").run(id, secs(start), secs(end), extra.transparent ?? 0);
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, ?, ?, 'accepted', 1)").run(`b${++counter}`, room, id);
	return id;
}
const reserve = (event = type, start = at(9), end = at(9, 30)) => reserveBooking({}, event, "Guest", "g@x.test", iso(start), iso(end));
const guestEvents = () => sqlite.prepare("SELECT id, user_id FROM calendar_events WHERE title LIKE '% with Guest' ORDER BY user_id").all().map((row) => ({ ...row }));
const bookings = () => sqlite.prepare("SELECT resource_id, status, event_id FROM calendar_resource_bookings WHERE event_id NOT LIKE 'rival%'").all().map((row) => ({ ...row }));

test("a booking of an event type with a room creates the host's event and an accepted booking of the room on it", async () => {
	setup();
	assert.equal(await reserve(), true);
	const [event] = guestEvents();
	assert.ok(event);
	assert.deepEqual(bookings(), [{ resource_id: "r1", status: "accepted", event_id: event.id }]);
});

test("every attached room is reserved", async () => {
	setup();
	assert.equal(await reserve({ ...type, resourceIds: ["r1", "r2"] }), true);
	assert.deepEqual(bookings().map((row) => [row.resource_id, row.status]).sort(), [["r1", "accepted"], ["r2", "accepted"]]);
});

test("a room taken by someone else fails the booking cleanly: no event is left, and no room is held", async () => {
	setup();
	rival("r1", at(8, 45), at(9, 15));
	assert.equal(await reserve(), false);
	assert.deepEqual(guestEvents(), []);
	assert.deepEqual(bookings(), []);
});

test("one room lost among several gives the other back too", async () => {
	setup();
	rival("r2", at(9), at(10));
	assert.equal(await reserve({ ...type, resourceIds: ["r1", "r2"] }), false);
	assert.deepEqual(guestEvents(), []);
	assert.deepEqual(bookings(), [], "r1 was free and accepted for a moment: it is released with the event");
	assert.equal(await reserve({ ...type, resourceIds: ["r1"] }, at(9), at(9, 30)), true, "so the next visitor gets r1");
});

test("a rival who wins the room between the check and the write wins; the visitor's booking fails whole", async () => {
	setup();
	beforeBatch = (db) => { beforeBatch = null; const id = "racer"; db.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone) VALUES ('${id}', 'o', 'Racer', ${secs(at(9))}, ${secs(at(9, 30))}, 1, 1, 'UTC'); INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('brace', 'r1', '${id}', 'accepted', 1); UPDATE calendar_resources SET booking_token = 'moved' WHERE id = 'r1';`); };
	assert.equal(await reserve(), false);
	assert.deepEqual(guestEvents(), []);
	assert.deepEqual(sqlite.prepare("SELECT event_id, status FROM calendar_resource_bookings").all().map((row) => ({ ...row })), [{ event_id: "racer", status: "accepted" }], "only the winner holds the room");
});

test("all of the hosts' events go when the room is lost, and none stays", async () => {
	setup();
	rival("r1", at(9), at(10));
	assert.equal(await reserve({ ...type, hostIds: ["h1", "h2"] }), false);
	assert.deepEqual(guestEvents(), []);
});

test("a multi-host booking holds the room on the first host's event only", async () => {
	setup();
	assert.equal(await reserve({ ...type, hostIds: ["h1", "h2"] }), true);
	const events = guestEvents();
	assert.equal(events.length, 2);
	assert.deepEqual(bookings().map((row) => row.event_id), [events.find((row) => row.user_id === "h1").id]);
});

test("a host who is busy still fails the booking before any room is touched", async () => {
	setup();
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone) VALUES ('busy', 'h1', 'Busy', ${secs(at(9))}, ${secs(at(10))}, 1, 1, 'UTC')`);
	assert.equal(await reserve(), false);
	assert.deepEqual(bookings(), []);
});

test("an event marked free does not make the host busy for the booking write (D-6, as in the slot list)", async () => {
	setup();
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone, transparent) VALUES ('free', 'h1', 'Lunch', ${secs(at(9))}, ${secs(at(10))}, 1, 1, 'UTC', 1)`);
	assert.equal(await reserve({ ...type, resourceIds: [] }), true);
});

test("an event type with no rooms books as before and writes no room rows", async () => {
	setup();
	assert.equal(await reserve({ ...type, resourceIds: [] }), true);
	assert.equal(guestEvents().length, 1);
	assert.deepEqual(bookings(), []);
});

test("a failure while booking the room removes the event and is not swallowed", async () => {
	setup();
	sqlite.exec("DROP TABLE calendar_resource_bookings");
	sqlite.exec("CREATE TABLE calendar_resource_bookings (id text)");
	await assert.rejects(reserve());
	assert.deepEqual(guestEvents(), []);
});

const tokens = () => sqlite.prepare("SELECT id, booking_token FROM calendar_resources ORDER BY id").all().map((row) => ({ ...row }));
const counts = () => ({ events: sqlite.prepare("SELECT count(*) AS n FROM calendar_events WHERE title LIKE '% with Guest'").get().n, bookings: sqlite.prepare("SELECT count(*) AS n FROM calendar_resource_bookings WHERE event_id NOT LIKE 'rival%'").get().n });

test("I-1: the process dying between any two statements of the reservation writes nothing (atomic batch)", async () => {
	for (let at = 0; at < 8; at += 1) {
		setup();
		const before = tokens();
		crashAt = at;
		let outcome;
		try { outcome = await reserve(); } catch (error) { outcome = error; }
		if (outcome === true) break; // past the last statement of the batch: nothing left to crash
		assert.ok(outcome instanceof Error, `statement ${at}`);
		assert.deepEqual(counts(), { events: 0, bookings: 0 }, `a crash before statement ${at} leaves no event and no room booking`);
		assert.deepEqual(tokens(), before, `and the room's token is unchanged (${at})`);
	}
});

test("I-1: the event and its room are written by one batch: no host event exists without its room booking", async () => {
	setup();
	const seen = [];
	betweenStatements = null;
	const original = globalThis.reserve.db.batch;
	globalThis.reserve.db.batch = (list) => { seen.push(list.length); return original(list); };
	assert.equal(await reserve(), true);
	assert.ok(seen.some((length) => length > 3), "one batch carries the swap, the guards, the events and the booking");
	assert.deepEqual(counts(), { events: 1, bookings: 1 });
});

test("a room turned off between the check and the write is not booked, and nothing is written", async () => {
	setup();
	beforeBatch = (db) => { beforeBatch = null; db.exec("UPDATE calendar_resources SET disabled = 1"); };
	assert.equal(await reserve(), false);
	assert.deepEqual(counts(), { events: 0, bookings: 0 });
});

test("a room closed to public booking pages between the check and the write is not booked either", async () => {
	setup();
	beforeBatch = (db) => { beforeBatch = null; db.exec("UPDATE calendar_resources SET public_booking = 0"); };
	assert.equal(await reserve(), false);
	assert.deepEqual(counts(), { events: 0, bookings: 0 });
});

test("a room that is not open to public booking pages is refused from the start", async () => {
	setup();
	sqlite.exec("UPDATE calendar_resources SET public_booking = 0");
	assert.equal(await reserve(), false);
	assert.deepEqual(counts(), { events: 0, bookings: 0 });
});

test("a host who becomes busy between the check and the write loses the booking whole: no event, no room, token unchanged", async () => {
	setup();
	const before = tokens();
	beforeBatch = (db) => { beforeBatch = null; db.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone) VALUES ('late', 'h1', 'Late meeting', ${secs(at(9))}, ${secs(at(10))}, 1, 1, 'UTC')`); };
	assert.equal(await reserve(), false);
	assert.deepEqual(counts(), { events: 0, bookings: 0 });
	assert.deepEqual(tokens(), before);
});

test("Neon (no transaction): a rival that books the room between our swap and our booking makes us give way, and our events are taken back", async () => {
	setup();
	globalThis.reserve.db.batchIsAtomic = false;
	betweenStatements = (index, db) => {
		// Just before the last statement (our room booking) a rival finishes its own reservation of the same room and time.
		if (index !== 6) return;
		betweenStatements = null;
		db.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone) VALUES ('rival_n', 'o', 'Rival', ${secs(at(9))}, ${secs(at(9, 30))}, 1, 1, 'UTC'); INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('brival_n', 'r1', 'rival_n', 'accepted', 1);`);
	};
	assert.equal(await reserve(), false);
	assert.deepEqual(counts(), { events: 0, bookings: 0 }, "only the rival's booking remains");
	assert.deepEqual(sqlite.prepare("SELECT event_id FROM calendar_resource_bookings").all().map((row) => row.event_id), ["rival_n"]);
});

test("Neon: a batch that fails part-way has its events taken back", async () => {
	setup();
	globalThis.reserve.db.batchIsAtomic = false;
	crashAt = 5;
	await assert.rejects(reserve());
	assert.deepEqual(counts(), { events: 0, bookings: 0 });
});

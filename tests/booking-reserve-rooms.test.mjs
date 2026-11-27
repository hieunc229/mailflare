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
let failBookRooms = false;
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
			if (list.length > 3) beforeBatch?.(sqlite);
			sqlite.exec("BEGIN");
			try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		});
		tail = next.catch(() => {});
		return next;
	};
	beforeBatch = null;
	failBookRooms = false;
	for (const id of ["h1", "h2", "o"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	for (const id of ["r1", "r2"]) sqlite.exec(`INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('${id}', 'Room ${id}', 1, 1)`);
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

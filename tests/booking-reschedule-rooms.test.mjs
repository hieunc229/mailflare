import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-8: a booking is an ordinary calendar event, so moving or cancelling it moves or frees its rooms through CS-7's paths.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = { "@/db": "export function getDb(){return globalThis.resched.db}", "@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.resched.team}}" };
const reserveFixture = await loadFixture({ name: "booking-resched-reserve", entryPoint: "src/lib/booking/reserve.ts", mocks });
const saveFixture = await loadFixture({ name: "booking-resched-save", entryPoint: "src/lib/calendar/room-save.ts", mocks });
const { reserveBooking } = await reserveFixture.import();
const { declineBookingsStatement, rebookEvents } = await saveFixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.resched; reserveFixture.dispose(); saveFixture.dispose(); });

const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7);
const at = (hours, minutes = 0) => T0 + hours * H + minutes * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const secs = (ms) => Math.floor(ms / 1000);
const type = { id: "book_1", userId: "h1", name: "Intro", hostIds: ["h1"], resourceIds: ["r1"], location: "", color: "blue", timeZone: "UTC" };

function setup() {
	sqlite?.close();
	sqlite = installSqlite("resched", { schema, extra: { team: true } });
	const db = globalThis.resched.db;
	const run = db.run.bind(db);
	db.run = async (query) => { await run(query); return { meta: { changes: Number(sqlite.prepare("select changes() as c").get().c) } }; };
	let tail = Promise.resolve();
	db.batch = (list) => {
		const next = tail.then(async () => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } });
		tail = next.catch(() => {});
		return next;
	};
	for (const id of ["h1", "o"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room 1', 1, 1)");
	return db;
}
const book = (start, end) => reserveBooking({}, type, "Guest", "g@x.test", iso(start), iso(end));
const guestEventId = () => sqlite.prepare("SELECT id FROM calendar_events WHERE title LIKE '% with Guest'").get().id;
const room = (eventId) => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").all(eventId).map((row) => row.status);

test("cancelling a booking (deleting its event) frees the room for the next visitor", async () => {
	setup();
	assert.equal(await book(at(9), at(9, 30)), true);
	const id = guestEventId();
	assert.deepEqual(room(id), ["accepted"]);
	sqlite.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
	assert.deepEqual(sqlite.prepare("SELECT * FROM calendar_resource_bookings").all(), [], "the booking row went with its event");
	assert.equal(await book(at(9), at(9, 30)), true, "the same time can be booked again");
});

test("moving a booking declines its room in the same write and the re-check books it at the new time", async () => {
	const db = setup();
	await book(at(9), at(9, 30));
	const id = guestEventId();
	await db.batch([db.run(`update calendar_events set starts_at = ${secs(at(14))}, ends_at = ${secs(at(14, 30))} where id = '${id}'`), declineBookingsStatement(db, id)].map((statement) => statement));
	assert.deepEqual(room(id), ["declined"], "fails closed until it has been checked");
	await rebookEvents(db, [id], async () => true);
	assert.deepEqual(room(id), ["accepted"]);
	assert.equal(await book(at(9), at(9, 30)), true, "the old time is free again");
	assert.equal(await book(at(14), at(14, 30)), false, "and the new time holds the room");
});

test("moving a booking onto a time the room is taken declines it and tells nobody it is booked", async () => {
	const db = setup();
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone) VALUES ('rival', 'o', 'Board', ${secs(at(14))}, ${secs(at(15))}, 1, 1, 'UTC'); INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('brival', 'r1', 'rival', 'accepted', 1);`);
	await book(at(9), at(9, 30));
	const id = guestEventId();
	sqlite.prepare("UPDATE calendar_events SET starts_at = ?, ends_at = ? WHERE id = ?").run(secs(at(14, 15)), secs(at(14, 45)), id);
	await rebookEvents(db, [id], async () => true);
	assert.deepEqual(room(id), ["declined"]);
	assert.deepEqual(room("rival"), ["accepted"], "the first booking keeps the room");
});

test("a lapsed licence keeps a declined booking declined when its event is re-checked", async () => {
	const db = setup();
	await book(at(9), at(9, 30));
	const id = guestEventId();
	sqlite.exec(`UPDATE calendar_resource_bookings SET status = 'declined', conflict_at = ${secs(at(9))} WHERE event_id = '${id}'`);
	globalThis.resched.team = false;
	await rebookEvents(db, [id], async () => false);
	assert.deepEqual(room(id), ["declined"]);
});

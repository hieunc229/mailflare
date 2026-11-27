import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// Findings of the independent review of the rooms branch, each pinned by a test.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomRv.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.roomRv;return s.user?{user:s.user,key:null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.roomRv.audit.push(input)}",
	"@/lib/email/send": "export async function sendEmail(env,input){globalThis.roomRv.sent.push(input)}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:true}}",
};
const load = (name, entryPoint, extra = mocks) => loadFixture({ name, entryPoint, mocks: extra });
const fixtures = [await load("room-rv-list", "src/app/api/calendar/events/route.ts"), await load("room-rv-item", "src/app/api/calendar/events/[eventId]/route.ts"), await load("room-rv-book", "src/lib/calendar/room-booking.ts", {}), await load("room-rv-save", "src/lib/calendar/room-save.ts", {}), await load("room-rv-utils", "src/app/(calendar)/calendar/room-utils.ts", {})];
const [{ GET: listEvents, POST: createEvent }, { PATCH: patchEvent }, { bookRooms }, { bookAndSummarize, rebookEvents }, { roomSaveErrorKey }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
let beforeBatch = null;
after(() => { sqlite?.close(); delete globalThis.roomRv; for (const fixture of fixtures) fixture.dispose(); });

const DAY = 86_400_000;
const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7);
const NOW = new Date(Date.UTC(2029, 11, 1));
const at = (days, hours = 0) => T0 + days * DAY + hours * H;
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;

function setup() {
	sqlite?.close();
	sqlite = installSqlite("roomRv", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, audit: [], sent: [] } });
	let tail = Promise.resolve();
	globalThis.roomRv.db.batch = (list) => {
		const run = tail.then(async () => {
			if (list.length > 3) beforeBatch?.(sqlite);
			sqlite.exec("BEGIN");
			try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		});
		tail = run.catch(() => {});
		return run;
	};
	beforeBatch = null;
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	for (const id of ["r1", "r2"]) sqlite.exec(`INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('${id}', 'Room ${id}', 1, 1)`);
	return globalThis.roomRv.db;
}
function event(user, start, end, extra = {}) {
	const row = { id: `e${++counter}`, repeat: "none", repeat_days: "[]", excluded_occurrences: "[]", time_zone: "UTC", ...extra };
	const columns = ["id", "user_id", "title", "starts_at", "ends_at", "created_at", "updated_at", ...Object.keys(row).filter((key) => key !== "id")];
	const values = [row.id, user, "Standup", secs(start), secs(end), 1, 1, ...Object.entries(row).filter(([key]) => key !== "id").map(([, value]) => value)];
	sqlite.prepare(`INSERT INTO calendar_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
	return row.id;
}
const book = (db, id, rooms) => bookRooms(db, id, rooms, { now: NOW });
const bookingsOf = (eventId) => sqlite.prepare("SELECT resource_id, status FROM calendar_resource_bookings WHERE event_id = ? ORDER BY resource_id").all(eventId).map((row) => [row.resource_id, row.status]);
const json = (body, method) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const fat = (days, hours = 0) => new Date(FUTURE + days * DAY + hours * H).toISOString();

test("a moved occurrence of the event's own series is checked too, not only its master", async () => {
	const db = setup();
	const series = event("u1", at(0, 9), at(0, 10), { repeat: "weekly", excluded_occurrences: JSON.stringify([at(7, 9)]) });
	event("u1", at(7, 14), at(7, 15), { dav_object_id: series, recurrence_id: secs(at(7, 9)) });
	const other = event("u2", at(7, 14.5), at(7, 15.5));
	assert.equal((await book(db, other, ["r1"])).rooms[0].status, "accepted");
	const result = await book(db, series, ["r1"]);
	assert.equal(result.rooms[0].status, "declined", "the moved week clashes with the other booking");
	assert.deepEqual(result.rooms[0].occurrences, [new Date(at(7, 14)).toISOString()]);
});

test("a booking is not declined because the room is busy elsewhere in the year: only the span of the event is read", async () => {
	const db = setup();
	for (let index = 0; index < 90; index += 1) { const id = event("u2", at(0, 10), at(0, 11), { repeat: "daily" }); sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, 'r1', ?, 'accepted', 1)").run(`crb_${index}`, id); }
	const mine = event("u1", at(3, 14), at(3, 15));
	assert.equal((await book(db, mine, ["r1"])).rooms[0].status, "accepted", "a free afternoon is bookable in a busy room");
	const clash = event("u1", at(3, 10.5), at(3, 11.5));
	const declined = await book(db, clash, ["r1"]);
	assert.equal(declined.rooms[0].status, "declined");
	assert.deepEqual(declined.rooms[0].occurrences, [new Date(at(3, 10.5)).toISOString()]);
});

test("Neon HTTP: a booking that stalls after its token swap while another books the room ends with at most one accepted (both may decline)", async () => {
	const db = setup();
	db.batchIsAtomic = false;
	// No transaction: statements run one by one, and the first writer pauses after its guards while the second one books the room completely.
	const a = event("u1", at(0, 9), at(0, 10));
	const b = event("u2", at(0, 9.5), at(0, 10.5));
	let stalled = false;
	let second;
	db.batch = async (list) => {
		let index = 0;
		if (!stalled && list.length > 3) {
			stalled = true;
			for (; index < 3; index += 1) await list[index];
			second = await bookRooms(db, b, ["r1"], { now: NOW });
		}
		for (; index < list.length; index += 1) await list[index];
	};
	const first = await book(db, a, ["r1"]);
	assert.equal(second.rooms[0].status, "accepted", "the second writer read the room before the first one's insert");
	const accepted = sqlite.prepare("SELECT count(*) AS n FROM calendar_resource_bookings WHERE status = 'accepted'").get().n;
	assert.equal(accepted <= 1, true, "never two accepted for overlapping times");
	assert.equal(first.rooms[0].status, "declined", "the writer whose insert landed last saw the other and gave way");
	assert.deepEqual(bookingsOf(a), [["r1", "declined"]]);
});

test("Neon HTTP: whichever of two overlapping accepted bookings checks last sees the other, whatever their creation order", async () => {
	const db = setup();
	db.batchIsAtomic = false;
	const a = event("u1", at(0, 9), at(0, 10));
	const b = event("u2", at(0, 9), at(0, 10));
	// b was created first and is already accepted; a's own write lands with an older created_at than b's.
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('crb_b', 'r1', ?, 'accepted', 100)").run(b);
	beforeBatch = null;
	const result = await book(db, a, ["r1"]);
	assert.equal(result.rooms[0].status, "declined", "the pre-check already sees b");
	assert.equal(bookingsOf(b)[0][1], "accepted");
});

test("a room deleted between the list check and the booking does not throw", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	assert.deepEqual((await book(db, a, ["gone"])).rooms, []);
	assert.deepEqual(bookingsOf(a), []);
});

test("if the room check fails after an event was saved, its bookings are declined (never left accepted at the new time) and the caller still gets an answer", async () => {
	const db = setup();
	const a = event("u1", at(0, 9), at(0, 10));
	await book(db, a, ["r1"]);
	assert.deepEqual(bookingsOf(a), [["r1", "accepted"]]);
	const real = db.batch;
	db.batch = async (list) => { if (list.length > 3) throw new Error("database busy"); return real(list); };
	const summary = await bookAndSummarize(db, a, ["r1"]);
	assert.deepEqual(summary.rooms.map((room) => [room.resourceId, room.status]), [["r1", "declined"]]);
	assert.deepEqual(summary.acceptedNames, []);
	assert.deepEqual(bookingsOf(a), [["r1", "declined"]]);
	// The same for a change made on a phone.
	db.batch = real;
	await book(db, a, ["r1"]);
	db.batch = async (list) => { if (list.length > 3) throw new Error("database busy"); return real(list); };
	await rebookEvents(db, [a]);
	assert.deepEqual(bookingsOf(a), [["r1", "declined"]]);
});

test("an event saved while the room step fails still answers 200, audits the delegate and is not saved twice", async () => {
	const db = setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u2', 'calendar', 'Work', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1', 'cal:work', 'u1', 'edit', 1)");
	const real = db.batch;
	db.batch = async (list) => { if (list.length > 3) throw new Error("database busy"); return real(list); };
	const response = await createEvent(new Request("https://m.test/api/calendar/events", json({ title: "Planning", startsAt: fat(0, 9), endsAt: fat(0, 10), calendarId: "cal:work", resourceIds: ["r1"] }, "POST")));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.rooms.map((room) => room.status), ["declined"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
	assert.deepEqual(globalThis.roomRv.audit.map((entry) => entry.action), ["calendar.event_created_by_delegate"]);
});

test("a moved occurrence reports its series' rooms, and saving it never removes them", async () => {
	setup();
	const series = event("u1", FUTURE - 28 * DAY + 9 * H, FUTURE - 28 * DAY + 10 * H, { repeat: "weekly", dav_object_id: null });
	sqlite.prepare("UPDATE calendar_events SET dav_object_id = id WHERE id = ?").run(series);
	const moved = event("u1", FUTURE + 14 * DAY + 14 * H, FUTURE + 14 * DAY + 15 * H, { dav_object_id: series, recurrence_id: secs(FUTURE + 14 * DAY + 9 * H) });
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', ?, 'accepted', 1)").run(series);
	const listed = await (await listEvents(new Request(`https://m.test/api/calendar/events?start=${fat(-30)}&end=${fat(30)}`))).json();
	assert.deepEqual(listed.events.find((item) => item.id === moved).rooms, [{ resourceId: "r1", status: "accepted", conflictAt: null }]);
	const saved = await patchEvent(new Request(`https://m.test/api/calendar/events/${moved}`, json({ title: "Moved", startsAt: fat(14, 14), endsAt: fat(14, 15), resourceIds: [] }, "PATCH")), { params: Promise.resolve({ eventId: moved }) });
	assert.equal(saved.status, 200);
	assert.deepEqual(bookingsOf(series), [["r1", "accepted"]], "the series keeps its room");
});

test("a refused save keeps its own message: only room errors are translated as room errors", () => {
	assert.equal(roomSaveErrorKey(403, "TEAM_REQUIRED"), "calendar.rooms.error.team");
	assert.equal(roomSaveErrorKey(400, "ROOM_UNKNOWN"), "calendar.rooms.error.invalid");
	assert.equal(roomSaveErrorKey(400, "TOO_MANY_ROOMS"), "calendar.rooms.error.invalid");
	assert.equal(roomSaveErrorKey(403, "INVITE_REQUIRES_OWNER"), null);
	assert.equal(roomSaveErrorKey(403), null);
	assert.equal(roomSaveErrorKey(400), null);
});

test("a moved occurrence of a private series is private in a room's schedule, whatever CLASS it carries itself", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u2', 'calendar', 'Work', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1', 'cal:work', 'u1', 'read', 1)");
	const series = event("u2", FUTURE + 9 * H, FUTURE + 10 * H, { repeat: "weekly", calendar_id: "cal:work", is_private: 1 });
	sqlite.prepare("UPDATE calendar_events SET title = 'Layoffs', dav_object_id = id WHERE id = ?").run(series);
	const moved = event("u2", FUTURE + 7 * DAY + 14 * H, FUTURE + 7 * DAY + 15 * H, { dav_object_id: series, recurrence_id: secs(FUTURE + 7 * DAY + 9 * H), calendar_id: "cal:work", is_private: 0 });
	sqlite.prepare("UPDATE calendar_events SET title = 'Layoffs round two' WHERE id = ?").run(moved);
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', ?, 'accepted', 1)").run(series);
	const body = await (await listEvents(new Request(`https://m.test/api/calendar/events?start=${fat(0)}&end=${fat(20)}&resourceIds=r1`))).json();
	assert.ok(body.roomEvents.length >= 2);
	assert.equal(JSON.stringify(body.roomEvents).includes("Layoffs"), false);
	assert.ok(body.roomEvents.every((item) => item.redacted));
});

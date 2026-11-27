import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomFb.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(env,request,scope){const s=globalThis.roomFb;return s.user?{user:s.user,key:null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomFb.team}}",
};
const service = await loadFixture({ name: "room-fb-service", entryPoint: "src/lib/calendar/free-busy.ts", mocks });
const route = await loadFixture({ name: "room-fb-route", entryPoint: "src/app/api/calendar/free-busy/route.ts", mocks });
const { busyIntervals } = await service.import();
const { POST } = await route.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomFb; service.dispose(); route.dispose(); });

const DAY = 86_400_000;
const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7);
const at = (days, hours = 0) => T0 + days * DAY + hours * H;
const iso = (days, hours = 0) => new Date(at(days, hours)).toISOString();
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;

function setup() {
	sqlite?.close();
	sqlite = installSqlite("roomFb", { schema, extra: { user: { id: "u1", calendarEnabled: true }, team: true } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U1', 'x', 'user', 1), ('u2', 'u2@one.test', 'U2', 'x', 'user', 1)");
	for (const [id, disabled] of [["r1", 0], ["r2", 0], ["r3", 1]]) sqlite.exec(`INSERT INTO calendar_resources (id, name, disabled, created_at, updated_at) VALUES ('${id}', 'Room ${id}', ${disabled}, 1, 1)`);
}
function booked(room, start, end, extra = {}, status = "accepted") {
	const row = { id: `e${++counter}`, repeat: "none", excluded_occurrences: "[]", time_zone: "UTC", transparent: 0, dav_object_id: null, recurrence_id: null, ...extra };
	sqlite.prepare(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, excluded_occurrences, time_zone, transparent, dav_object_id, recurrence_id, created_at, updated_at) VALUES (?, 'u2', 'Secret board meeting', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`).run(row.id, secs(start), secs(end), row.repeat, row.excluded_occurrences, row.time_zone, row.transparent, row.dav_object_id, row.recurrence_id);
	if (room) sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, ?, ?, ?, 1)").run(`b${counter}`, room, row.id, status);
	return row.id;
}
const win = (from, to) => [new Date(from), new Date(to)];
const rooms = (ids, from, to, extra = {}) => busyIntervals({}, { userIds: [], resourceIds: ids, ...extra }, ...win(from, to));

test("a room is busy where an accepted booking's event is; declined bookings, other rooms and unbooked events are not", async () => {
	setup();
	booked("r1", at(0, 9), at(0, 10));
	booked("r1", at(0, 12), at(0, 13), {}, "declined");
	booked("r2", at(0, 14), at(0, 15));
	booked(null, at(0, 16), at(0, 17));
	const result = await rooms(["r1", "r2", "r3"], at(0), at(1));
	assert.deepEqual(result.get("r1"), [[at(0, 9), at(0, 10)]]);
	assert.deepEqual(result.get("r2"), [[at(0, 14), at(0, 15)]]);
	assert.deepEqual(result.get("r3"), [], "every room asked about has an entry");
});

test("a series, its exclusions and a moved occurrence are expanded like anyone's calendar; a transparent event still holds the room", async () => {
	setup();
	const series = booked("r1", at(0, 9), at(0, 10), { repeat: "weekly", excluded_occurrences: JSON.stringify([at(7, 9)]) });
	booked(null, at(14, 14), at(14, 15), { dav_object_id: series, recurrence_id: secs(at(14, 9)) });
	sqlite.prepare("UPDATE calendar_events SET excluded_occurrences = ? WHERE id = ?").run(JSON.stringify([at(7, 9), at(14, 9)]), series);
	booked("r1", at(1, 9), at(1, 10), { transparent: 1 });
	const busy = (await rooms(["r1"], at(0), at(21))).get("r1");
	assert.deepEqual(busy.map(([from]) => from), [at(0, 9), at(1, 9), at(14, 14)]);
});

test("the event being edited does not make its own room busy, nor does its later occurrences when saving splits the series", async () => {
	setup();
	const series = booked("r1", at(0, 9), at(0, 10), { repeat: "weekly" });
	const other = booked("r1", at(2, 9), at(2, 10));
	const free = (await rooms(["r1"], at(0), at(15), { excludeEventId: series })).get("r1");
	assert.deepEqual(free, [[at(2, 9), at(2, 10)]]);
	const split = (await rooms(["r1"], at(0), at(22), { excludeEventId: series, excludeOccurrence: at(14, 9) })).get("r1");
	assert.deepEqual(split.map(([from]) => from), [at(0, 9), at(2, 9), at(7, 9)]);
	assert.ok(other);
});

test("a room that cannot be read in full is busy for the whole window, never free", async () => {
	setup();
	// 90 daily series over 62 days cost more than a room's share of the work limit.
	for (let index = 0; index < 90; index += 1) booked("r1", at(0, 9), at(0, 10), { repeat: "daily" });
	assert.deepEqual((await rooms(["r1"], at(0), at(62))).get("r1"), [[at(0), at(62)]]);
	setup();
	for (let index = 0; index < 5; index += 1) booked("r1", at(0, 9), at(0, 10), { repeat: "daily" });
	assert.notDeepEqual((await rooms(["r1"], at(0), at(62))).get("r1"), [[at(0), at(62)]], "a normal load is answered exactly");
});

test("people and rooms together stay within 50", async () => {
	setup();
	await assert.rejects(() => busyIntervals({}, { userIds: Array.from({ length: 30 }, (_, i) => `x${i}`), resourceIds: Array.from({ length: 21 }, (_, i) => `r${i}`) }, ...win(at(0), at(1))), /at most 50/);
});

const post = (body) => POST(new Request("https://m.test/api/calendar/free-busy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

test("the route answers a known room with its busy times, whatever the licence, and leaves out an id that names no room", async () => {
	setup();
	booked("r1", at(0, 9), at(0, 10));
	const asked = { resourceIds: ["r1", "r3", "nope"], start: iso(0), end: iso(1) };
	const { results } = await (await post(asked)).json();
	assert.deepEqual(results.r1, { status: "ok", busy: [[iso(0, 9), iso(0, 10)]] });
	assert.deepEqual(results.r3, { status: "ok", busy: [] }, "a switched-off room keeps its bookings");
	assert.equal("nope" in results, false, "an id that names no room is not answered");
	assert.doesNotMatch(JSON.stringify(results), /board meeting/);
	globalThis.roomFb.team = false;
	assert.equal((await (await post(asked)).json()).results.r1.status, "ok", "existing rooms stay readable after a licence lapses");
});

test("people and rooms are answered together, and the event being edited is left out of its room", async () => {
	setup();
	const mine = booked("r1", at(0, 9), at(0, 10));
	sqlite.prepare("UPDATE calendar_events SET user_id = 'u1' WHERE id = ?").run(mine);
	const asked = { addresses: ["u1@one.test"], resourceIds: ["r1"], start: iso(0), end: iso(1) };
	const together = (await (await post(asked)).json()).results;
	assert.equal(together["u1@one.test"].status, "ok");
	assert.equal(together.r1.busy.length, 1);
	const editing = (await (await post({ ...asked, excludeEventId: mine })).json()).results;
	assert.deepEqual(editing.r1.busy, []);
	const stranger = (await (await post({ ...asked, excludeEventId: "someone-elses" })).json()).results;
	assert.equal(stranger.r1.busy.length, 1);
});

test("a request needs a signed-in user and keeps the 50-id limit across people and rooms", async () => {
	setup();
	globalThis.roomFb.user = null;
	assert.equal((await post({ resourceIds: ["r1"], start: iso(0), end: iso(1) })).status, 401);
	globalThis.roomFb.user = { id: "u1" };
	assert.equal((await post({ addresses: Array.from({ length: 30 }, (_, i) => `a${i}@x.test`), resourceIds: Array.from({ length: 21 }, (_, i) => `r${i}`), start: iso(0), end: iso(1) })).status, 400);
});

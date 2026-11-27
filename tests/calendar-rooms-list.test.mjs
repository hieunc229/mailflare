import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomLs.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.roomLs;return s.user?{user:s.user,key:null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomLs.team}}",
};
const load = (name, entryPoint) => loadFixture({ name, entryPoint, mocks });
const fixtures = [await load("room-ls-res", "src/app/api/calendar/resources/route.ts"), await load("room-ls-events", "src/app/api/calendar/events/route.ts")];
const [{ GET: listResources }, { GET: listEvents }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomLs; for (const fixture of fixtures) fixture.dispose(); });

const DAY = 86_400_000;
const T0 = Date.UTC(2030, 0, 7);
const secs = (ms) => Math.floor(ms / 1000);
const iso = (days, hours = 0) => new Date(T0 + days * DAY + hours * 3_600_000).toISOString();

function setup() {
	sqlite?.close();
	sqlite = installSqlite("roomLs", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, team: true } });
	for (const id of ["u1", "u2", "u3"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	for (const [id, name, disabled] of [["r1", "Boardroom", 0], ["r2", "Annex", 0], ["r3", "Old room", 1]]) sqlite.exec(`INSERT INTO calendar_resources (id, name, kind, capacity, location, description, disabled, created_at, updated_at) VALUES ('${id}', '${name}', 'room', 8, '2nd floor', 'Secret admin note', ${disabled}, 1, 1)`);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u2', 'calendar', 'Work', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1', 'cal:work', 'u1', 'read', 1)");
}
let counter = 0;
function booked(owner, room, start, end, extra = {}, status = "accepted") {
	const id = `e${++counter}`;
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, description, location, attendees, is_private, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'Salary talk', 'CEO office', '[\"x@y.test\"]', ?, ?, ?, 1, 1)")
		.run(id, owner, extra.calendar ?? null, extra.title ?? `Meeting ${id}`, extra.private ? 1 : 0, secs(start), secs(end));
	if (room) sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, conflict_at, created_at) VALUES (?, ?, ?, ?, ?, 1)").run(`b${counter}`, room, id, status, status === "declined" ? secs(start) : null);
	return id;
}
const get = (url, handler = listEvents) => handler(new Request(`https://m.test${url}`));
const events = (query = "") => get(`/api/calendar/events?start=${iso(0)}&end=${iso(2)}${query}`);

test("the picker list is the enabled rooms with what a booker needs, not the admin's notes, and says whether booking is available", async () => {
	setup();
	const body = await (await get("/api/calendar/resources", listResources)).json();
	assert.deepEqual(body.resources, [{ id: "r2", name: "Annex", kind: "room", capacity: 8, location: "2nd floor" }, { id: "r1", name: "Boardroom", kind: "room", capacity: 8, location: "2nd floor" }]);
	assert.equal(body.canBook, true);
	globalThis.roomLs.team = false;
	const lapsed = await (await get("/api/calendar/resources", listResources)).json();
	assert.deepEqual([lapsed.resources.length, lapsed.canBook], [2, false]);
	globalThis.roomLs.user = null;
	assert.equal((await get("/api/calendar/resources", listResources)).status, 401);
});

test("an event lists the rooms it is booked for; events without rooms and events the viewer only sees as busy carry none", async () => {
	setup();
	const mine = booked("u1", "r1", T0 + 9 * 3_600_000, T0 + 10 * 3_600_000);
	booked("u1", null, T0 + 11 * 3_600_000, T0 + 12 * 3_600_000);
	const lost = booked("u1", "r2", T0 + 13 * 3_600_000, T0 + 14 * 3_600_000, {}, "declined");
	const theirsPrivate = booked("u2", "r1", T0 + 15 * 3_600_000, T0 + 16 * 3_600_000, { calendar: "cal:work", private: true });
	const theirs = booked("u2", "r2", T0 + 17 * 3_600_000, T0 + 18 * 3_600_000, { calendar: "cal:work" });
	const list = (await (await events()).json()).events;
	const byId = Object.fromEntries(list.map((event) => [event.id, event]));
	assert.deepEqual(byId[mine].rooms, [{ resourceId: "r1", status: "accepted", conflictAt: null }]);
	assert.deepEqual(byId[lost].rooms, [{ resourceId: "r2", status: "declined", conflictAt: iso(0, 13) }]);
	assert.deepEqual(byId[theirs].rooms, [{ resourceId: "r2", status: "accepted", conflictAt: null }], "a reader sees the rooms of an event they can read");
	assert.equal("rooms" in byId[theirsPrivate], false, "a private event's rooms are part of what is hidden");
	assert.equal(list.filter((event) => !("rooms" in event)).length, 2);
});

test("a room's schedule lists its accepted bookings; titles show for events the viewer may read, everything else is Busy and carries no details", async () => {
	setup();
	const mine = booked("u1", "r1", T0 + 9 * 3_600_000, T0 + 10 * 3_600_000, { title: "My standup" });
	const readable = booked("u2", "r1", T0 + 11 * 3_600_000, T0 + 12 * 3_600_000, { calendar: "cal:work", title: "Team lunch" });
	const hidden = booked("u2", "r1", T0 + 13 * 3_600_000, T0 + 14 * 3_600_000, { calendar: "cal:work", title: "Layoffs", private: true });
	const stranger = booked("u3", "r1", T0 + 15 * 3_600_000, T0 + 16 * 3_600_000, { title: "Acquisition" });
	booked("u3", "r1", T0 + 17 * 3_600_000, T0 + 18 * 3_600_000, { title: "Lost" }, "declined");
	booked("u3", "r2", T0 + 19 * 3_600_000, T0 + 20 * 3_600_000, { title: "Other room" });
	const body = await (await events("&resourceIds=r1")).json();
	const view = Object.fromEntries(body.roomEvents.map((event) => [event.id, event]));
	assert.deepEqual(Object.keys(view).sort(), [mine, readable, hidden, stranger].sort());
	assert.deepEqual([view[mine].title, view[readable].title, view[hidden].title, view[stranger].title], ["My standup", "Team lunch", "Busy", "Busy"]);
	assert.deepEqual([view[mine].redacted, view[readable].redacted, view[hidden].redacted, view[stranger].redacted].map(Boolean), [false, false, true, true]);
	assert.ok(body.roomEvents.every((event) => event.resourceId === "r1"));
	const text = JSON.stringify(body.roomEvents);
	for (const secret of ["Salary talk", "CEO office", "x@y.test", "Layoffs", "Acquisition", "cal:work", "u3"]) assert.equal(text.includes(secret), false, secret);
	assert.equal("roomEvents" in (await (await events()).json()), false, "only when rooms are asked for");
});

test("a room schedule takes up to 20 rooms and ignores ids that are not rooms; a switched-off room still shows its bookings", async () => {
	setup();
	booked("u1", "r3", T0 + 9 * 3_600_000, T0 + 10 * 3_600_000);
	const some = await (await events("&resourceIds=r3,nope")).json();
	assert.equal(some.roomEvents.length, 1);
	const many = Array.from({ length: 21 }, (_, index) => `x${index}`).join(",");
	assert.equal((await events(`&resourceIds=${many}`)).status, 400);
});

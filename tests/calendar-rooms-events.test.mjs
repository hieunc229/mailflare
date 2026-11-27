import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomEv.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.roomEv;return s.user?{user:s.user,key:null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.roomEv.audit.push(input)}",
	"@/lib/email/send": "export async function sendEmail(env,input){globalThis.roomEv.sent.push(input)}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomEv.team}}",
};
const load = (name, entryPoint) => loadFixture({ name, entryPoint, mocks });
const fixtures = [await load("room-ev-list", "src/app/api/calendar/events/route.ts"), await load("room-ev-item", "src/app/api/calendar/events/[eventId]/route.ts")];
const [{ POST: createEvent }, { PATCH: patchEvent, DELETE: deleteEvent }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomEv; for (const fixture of fixtures) fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4); // a Monday-ish day next year, well inside the horizon
const DAY = 86_400_000;
const at = (days, hours = 0) => new Date(FUTURE + days * DAY + hours * 3_600_000).toISOString();

function setup({ team = true } = {}) {
	sqlite?.close();
	sqlite = installSqlite("roomEv", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, audit: [], sent: [], team } });
	globalThis.roomEv.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	for (const [id, name] of [["r1", "Room A"], ["r2", "Room B"], ["r3", "Room C"]]) sqlite.exec(`INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('${id}', '${name}', 1, 1)`);
	sqlite.exec("UPDATE calendar_resources SET disabled = 1 WHERE id = 'r3'");
	sqlite.exec("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'one.test', 'z', 1)");
	sqlite.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 1)");
}
const json = (body, method) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const body = (extra = {}) => ({ title: "Standup", startsAt: at(0, 9), endsAt: at(0, 10), ...extra });
const create = async (extra) => { const response = await createEvent(new Request("https://m.test/api/calendar/events", json(body(extra), "POST"))); return { response, data: await response.json() }; };
const patch = (id, extra, base = body()) => patchEvent(new Request(`https://m.test/api/calendar/events/${id}`, json({ ...base, ...extra }, "PATCH")), { params: Promise.resolve({ eventId: id }) });
const remove = (id, extra) => deleteEvent(new Request(`https://m.test/api/calendar/events/${id}`, json(extra ?? {}, "DELETE")), { params: Promise.resolve({ eventId: id }) });
const bookings = (eventId) => sqlite.prepare("SELECT resource_id, status FROM calendar_resource_bookings WHERE event_id = ? ORDER BY resource_id").all(eventId).map((row) => [row.resource_id, row.status]);
const ics = () => new TextDecoder().decode(globalThis.roomEv.sent.at(-1).attachments[0].content);

test("an event saved with a room books it and says so; one without rooms answers as before", async () => {
	setup();
	const { response, data } = await create({ resourceIds: ["r1"] });
	assert.equal(response.status, 200);
	assert.deepEqual(data.rooms.map((room) => [room.resourceId, room.name, room.status]), [["r1", "Room A", "accepted"]]);
	assert.deepEqual(data.resourceConflicts, []);
	assert.deepEqual(bookings(data.event.id), [["r1", "accepted"]]);
	const plain = await create();
	assert.equal("rooms" in plain.data, false);
	assert.equal(plain.data.event.calendarId !== undefined, true);
});

test("a second event on the same slot is saved with the room declined and the clash dates listed (first booking wins)", async () => {
	setup();
	await create({ resourceIds: ["r1"] });
	const { response, data } = await create({ resourceIds: ["r1", "r2"], startsAt: at(0, 9.5), endsAt: at(0, 10.5) });
	assert.equal(response.status, 200, "the event itself is saved");
	assert.deepEqual(data.rooms.map((room) => [room.resourceId, room.status]), [["r1", "declined"], ["r2", "accepted"]]);
	assert.deepEqual(data.resourceConflicts, [{ resourceId: "r1", occurrences: [at(0, 9.5)] }]);
	assert.deepEqual(bookings(data.event.id), [["r1", "declined"], ["r2", "accepted"]]);
});

test("bad room lists are refused before anything is written: unknown or switched-off rooms, more than five, a non-list", async () => {
	setup();
	for (const resourceIds of [["nope"], ["r3"], ["r1", "r2", "x1", "x2", "x3", "x4"], "r1"]) {
		const { response } = await create({ resourceIds });
		assert.equal(response.status, 400, JSON.stringify(resourceIds));
	}
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
});

test("without a Team licence a new booking is 403 and the event is not saved; an event without rooms is unaffected", async () => {
	setup({ team: false });
	const { response, data } = await create({ resourceIds: ["r1"] });
	assert.deepEqual([response.status, data.code], [403, "TEAM_REQUIRED"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
	assert.equal((await create({ resourceIds: [] })).response.status, 200);
	assert.equal((await create()).response.status, 200);
});

test("the invitation's LOCATION is the event's location, then the accepted rooms; a declined room is not named", async () => {
	setup();
	const guests = { attendees: ["g@x.test"], mailboxId: "m1", from: "u1@one.test" };
	await create({ ...guests, location: "HQ", resourceIds: ["r1", "r2"] });
	assert.match(ics(), /LOCATION:HQ[\\]; Room A[\\], Room B\r?\n/);
	await create({ ...guests, location: "", resourceIds: ["r1"], startsAt: at(1, 9), endsAt: at(1, 10) });
	assert.match(ics(), /LOCATION:Room A\r?\n/);
	await create({ ...guests, location: "HQ", resourceIds: ["r1", "r2"], startsAt: at(1, 9.5), endsAt: at(1, 10.5) });
	assert.match(ics(), /LOCATION:HQ[\\]; Room B\r?\n/, "r1 is taken then, so only r2 is named");
	await create({ ...guests, location: "HQ" });
	assert.match(ics(), /LOCATION:HQ\r?\n/);
});

test("moving an event onto a booked slot declines its room; moving it back accepts it; a title edit keeps the room", async () => {
	setup();
	await create({ resourceIds: ["r1"] });
	const { data } = await create({ resourceIds: ["r1"], startsAt: at(0, 11), endsAt: at(0, 12) });
	const id = data.event.id;
	const clash = await patch(id, { startsAt: at(0, 9.5), endsAt: at(0, 10.5) }, body({ title: "Moved" }));
	assert.deepEqual(await clash.json(), { ok: true, rooms: [{ resourceId: "r1", name: "Room A", status: "declined", conflictAt: at(0, 9.5) }], resourceConflicts: [{ resourceId: "r1", occurrences: [at(0, 9.5)] }] });
	assert.deepEqual(bookings(id), [["r1", "declined"]]);
	await patch(id, { startsAt: at(0, 11), endsAt: at(0, 12) }, body({ title: "Back" }));
	assert.deepEqual(bookings(id), [["r1", "accepted"]]);
	await patch(id, { title: "Renamed", startsAt: at(0, 11), endsAt: at(0, 12) });
	assert.deepEqual(bookings(id), [["r1", "accepted"]]);
});

test("a save names the rooms it wants: adding, replacing and clearing them", async () => {
	setup();
	const { data } = await create({ resourceIds: ["r1"] });
	const id = data.event.id;
	await patch(id, { resourceIds: ["r1", "r2"] });
	assert.deepEqual(bookings(id), [["r1", "accepted"], ["r2", "accepted"]]);
	await patch(id, { resourceIds: ["r2"] });
	assert.deepEqual(bookings(id), [["r2", "accepted"]]);
	const cleared = await patch(id, { resourceIds: [] });
	assert.deepEqual(bookings(id), []);
	assert.deepEqual(await cleared.json(), { ok: true });
	assert.equal((await patch(id, { resourceIds: ["nope"] })).status, 400);
});

test("after a licence lapses a booked event can still be saved, but a new room is refused", async () => {
	setup();
	const { data } = await create({ resourceIds: ["r1"] });
	globalThis.roomEv.team = false;
	assert.equal((await patch(data.event.id, { title: "Still booked" })).status, 200);
	assert.equal((await patch(data.event.id, { resourceIds: ["r1"] })).status, 200);
	assert.deepEqual(bookings(data.event.id), [["r1", "accepted"]]);
	const refused = await patch(data.event.id, { resourceIds: ["r1", "r2"] });
	assert.deepEqual([refused.status, (await refused.json()).code], [403, "TEAM_REQUIRED"]);
	assert.deepEqual(bookings(data.event.id), [["r1", "accepted"]]);
	assert.equal((await patch(data.event.id, { resourceIds: [] })).status, 200, "removing is always possible");
});

test("a series split: this-and-following gives the new series the rooms and the old one keeps its own", async () => {
	setup();
	const { data } = await create({ repeat: "weekly", startsAt: at(-28, 9), endsAt: at(-28, 10), resourceIds: ["r1"] });
	const id = data.event.id;
	const split = await patch(id, { repeat: "weekly", effectiveFrom: at(14, 9), startsAt: at(14, 13), endsAt: at(14, 14), resourceIds: ["r1", "r2"] }, body({ startsAt: at(-28, 9), endsAt: at(-28, 10) }));
	assert.equal(split.status, 200);
	const rows = sqlite.prepare("SELECT id, repeat_until FROM calendar_events ORDER BY created_at, id").all();
	const fresh = rows.find((row) => row.id !== id).id;
	assert.deepEqual(bookings(id), [["r1", "accepted"]], "the old series keeps the room it had");
	assert.deepEqual(bookings(fresh), [["r1", "accepted"], ["r2", "accepted"]]);
	// Without naming rooms the new series carries the old series' rooms over.
	const again = await patch(fresh, { repeat: "weekly", effectiveFrom: at(35, 13), startsAt: at(35, 15), endsAt: at(35, 16) }, body({ startsAt: at(14, 13), endsAt: at(14, 14) }));
	assert.equal(again.status, 200);
	const third = sqlite.prepare("SELECT id FROM calendar_events WHERE id NOT IN (?, ?)").get(id, fresh).id;
	assert.deepEqual(bookings(third), [["r1", "accepted"], ["r2", "accepted"]]);
});

test("moving one occurrence into the past keeps the series' booking", async () => {
	setup();
	const { data } = await create({ repeat: "weekly", startsAt: at(-28, 9), endsAt: at(-28, 10), resourceIds: ["r1"] });
	const past = Date.now() - 3 * DAY;
	const response = await patch(`${data.event.id}@${FUTURE - 21 * DAY + 9 * 3_600_000}`, { moveOccurrenceToPast: true, startsAt: new Date(past).toISOString(), endsAt: new Date(past + 3_600_000).toISOString() }, body({ startsAt: at(-28, 9), endsAt: at(-28, 10) }));
	assert.ok(response.status === 200 || response.status === 404, `status ${response.status}`);
	assert.deepEqual(bookings(data.event.id), [["r1", "accepted"]]);
});

test("deleting the event frees the room at once; ending a series early keeps its booking", async () => {
	setup();
	const { data: a } = await create({ resourceIds: ["r1"] });
	assert.equal((await remove(a.event.id)).status, 200);
	assert.deepEqual(bookings(a.event.id), []);
	const { data: b } = await create({ resourceIds: ["r1"] });
	assert.equal(b.rooms[0].status, "accepted", "the slot is free again");
	const { data: series } = await create({ repeat: "weekly", startsAt: at(7, 14), endsAt: at(7, 15), resourceIds: ["r2"] });
	assert.equal((await remove(series.event.id, { effectiveFrom: at(21, 14) })).status, 200);
	assert.deepEqual(bookings(series.event.id), [["r2", "accepted"]]);
});

test("an editor of a shared calendar books rooms for the owner's event", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u2', 'calendar', 'Work', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1', 'cal:work', 'u1', 'edit', 1)");
	const { response, data } = await create({ calendarId: "cal:work", resourceIds: ["r1"] });
	assert.equal(response.status, 200);
	assert.equal(sqlite.prepare("SELECT user_id FROM calendar_events WHERE id = ?").get(data.event.id).user_id, "u2");
	assert.deepEqual(bookings(data.event.id), [["r1", "accepted"]]);
});

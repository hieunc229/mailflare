import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calMulti.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.calMulti;return s.user?{user:s.user,key:null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.calMulti.audit.push(input)}",
	"@/lib/email/send": "export async function sendEmail(){}",
};
const load = (name, entryPoint) => loadFixture({ name, entryPoint, mocks });
const fixtures = [
	await load("cal-multi-list", "src/app/api/calendar/calendars/route.ts"),
	await load("cal-multi-item", "src/app/api/calendar/calendars/[id]/route.ts"),
	await load("cal-multi-events", "src/app/api/calendar/events/route.ts"),
	await load("cal-multi-event", "src/app/api/calendar/events/[eventId]/route.ts"),
];
const [{ GET: listCalendars, POST: createCalendar }, { PATCH: patchCalendar, DELETE: deleteCalendar }, { GET: listEvents, POST: createEvent }, { PATCH: patchEvent }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calMulti; for (const fixture of fixtures) fixture.dispose(); });

function setup() {
	sqlite?.close();
	sqlite = installSqlite("calMulti", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, audit: [] } });
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:theirs', 'u2', 'calendar', 'Theirs', 1, 1)");
}
const json = (body, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id) => ({ params: Promise.resolve({ id }) });
const eventParams = (eventId) => ({ params: Promise.resolve({ eventId }) });
const audit = () => globalThis.calMulti.audit;
const eventBody = (extra = {}) => ({ title: "Standup", startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T11:00:00.000Z", ...extra });
const mk = async (name = "Work") => (await (await createCalendar(new Request("https://m.test/api/calendar/calendars", json({ name, color: "#7c3aed" })))).json()).calendar;

test("GET lists the default calendar first and then the user's own, never another user's", async () => {
	setup();
	await mk("Work");
	const body = await (await listCalendars(new Request("https://m.test/api/calendar/calendars"))).json();
	assert.deepEqual(body.calendars.map((calendar) => [calendar.name, calendar.isDefault, calendar.role]), [[null, true, "owner"], ["Work", false, "owner"]]);
});

test("the calendar routes need a signed-in user", async () => {
	setup();
	globalThis.calMulti.user = null;
	assert.equal((await listCalendars(new Request("https://m.test/api/calendar/calendars"))).status, 401);
	assert.equal((await createCalendar(new Request("https://m.test/x", json({ name: "A" })))).status, 401);
});

test("POST creates a calendar and writes a calendar.created audit entry for its owner", async () => {
	setup();
	const response = await createCalendar(new Request("https://m.test/x", json({ name: "Work", color: "#16a34a", description: "d" })));
	assert.equal(response.status, 200);
	const { calendar } = await response.json();
	assert.equal(audit().length, 1);
	assert.deepEqual([audit()[0].action, audit()[0].actorUserId, audit()[0].targetUserId, audit()[0].metadata.calendarId], ["calendar.created", "u1", "u1", calendar.id]);
	assert.equal((await createCalendar(new Request("https://m.test/x", json({ name: "" })))).status, 400);
	assert.equal((await createCalendar(new Request("https://m.test/x", { method: "POST", body: "{" }))).status, 400);
	assert.equal(audit().length, 1);
});

test("PATCH renames (the default included) with an audit entry; another user's calendar is 404", async () => {
	setup();
	const calendar = await mk();
	audit().length = 0;
	const renamed = await patchCalendar(new Request("https://m.test/x", json({ name: "Team" }, "PATCH")), params(encodeURIComponent(calendar.id)));
	assert.equal(renamed.status, 200);
	assert.equal((await renamed.json()).calendar.name, "Team");
	assert.deepEqual(audit().map((entry) => [entry.action, entry.metadata.calendarId]), [["calendar.updated", calendar.id]]);
	assert.equal((await patchCalendar(new Request("https://m.test/x", json({ name: "Mine" }, "PATCH")), params("cal:u1"))).status, 200);
	assert.equal((await patchCalendar(new Request("https://m.test/x", json({ name: "Mine" }, "PATCH")), params("cal:theirs"))).status, 404);
	assert.equal(sqlite.prepare("SELECT display_name FROM dav_collections WHERE id = 'cal:theirs'").get().display_name, "Theirs");
});

test("DELETE needs confirm:true, refuses the default, deletes the calendar's events and audits the count", async () => {
	setup();
	const calendar = await mk();
	for (const id of ["e1", "e2"]) sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', ?, 'E', 1, 2, 1, 1)").run(id, calendar.id);
	audit().length = 0;
	assert.equal((await deleteCalendar(new Request("https://m.test/x", json({}, "DELETE")), params(calendar.id))).status, 400);
	assert.equal((await deleteCalendar(new Request("https://m.test/x", { method: "DELETE" }), params(calendar.id))).status, 400);
	assert.equal((await deleteCalendar(new Request("https://m.test/x", json({ confirm: true }, "DELETE")), params("cal:u1"))).status, 409);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 2);
	const done = await deleteCalendar(new Request("https://m.test/x", json({ confirm: true }, "DELETE")), params(encodeURIComponent(calendar.id)));
	assert.deepEqual([done.status, (await done.json()).deletedEvents], [200, 2]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
	assert.deepEqual(audit().map((entry) => [entry.action, entry.metadata.calendarId, entry.metadata.eventCount]), [["calendar.deleted", calendar.id, 2]]);
	assert.equal((await deleteCalendar(new Request("https://m.test/x", json({ confirm: true }, "DELETE")), params("cal:theirs"))).status, 404);
});

test("POST event takes calendarId: stored for a named calendar, null for the default, 404 for one the user does not own", async () => {
	setup();
	const calendar = await mk();
	const post = (extra) => createEvent(new Request("https://m.test/api/calendar/events", json(eventBody(extra))));
	assert.equal((await post({ calendarId: calendar.id })).status, 200);
	assert.equal((await post({ calendarId: "cal:u1" })).status, 200);
	assert.equal((await post({})).status, 200);
	assert.equal((await post({ calendarId: "cal:theirs" })).status, 404);
	assert.equal((await post({ calendarId: 5 })).status, 404);
	assert.deepEqual(sqlite.prepare("SELECT calendar_id FROM calendar_events ORDER BY rowid").all().map((row) => row.calendar_id), [calendar.id, null, null]);
});

test("GET events returns calendarId on every event and honours calendarIds", async () => {
	setup();
	const calendar = await mk();
	const insert = sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, 'E', ?, ?, 1, 1)");
	const at = Date.parse("2026-12-01T10:00:00Z") / 1000;
	insert.run("a", "u1", null, at, at + 3600); insert.run("b", "u1", calendar.id, at, at + 3600); insert.run("c", "u2", null, at, at + 3600);
	const get = async (query = "") => (await (await listEvents(new Request(`https://m.test/api/calendar/events?start=2026-12-01T00:00:00Z&end=2026-12-02T00:00:00Z${query}`))).json()).events;
	const all = await get();
	assert.deepEqual(all.map((event) => [event.id, event.calendarId]).sort(), [["a", "cal:u1"], ["b", calendar.id]]);
	assert.deepEqual((await get(`&calendarIds=${encodeURIComponent(calendar.id)}`)).map((event) => event.id), ["b"]);
	assert.deepEqual((await get("&calendarIds=cal:u1")).map((event) => event.id), ["a"]);
	assert.deepEqual(await get("&calendarIds=cal:theirs"), []);
});

test("PATCH event with calendarId moves the master and its override rows; omitting it keeps the calendar", async () => {
	setup();
	const calendar = await mk();
	const insert = sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, dav_object_id, recurrence_id) VALUES (?, 'u1', 'E', 1795000000, 1795003600, 1, 1, 'm1', ?)");
	insert.run("m1", null); insert.run("o1", 1795086400); insert.run("o2", 1795172800);
	const patch = (extra) => patchEvent(new Request("https://m.test/x", json(eventBody({ startsAt: "2026-11-17T10:00:00.000Z", endsAt: "2026-11-17T11:00:00.000Z", ...extra }), "PATCH")), eventParams("m1"));
	assert.equal((await patch({})).status, 200);
	assert.deepEqual(sqlite.prepare("SELECT calendar_id FROM calendar_events").all().map((row) => row.calendar_id), [null, null, null]);
	assert.equal((await patch({ calendarId: "cal:theirs" })).status, 404);
	assert.equal((await patch({ calendarId: calendar.id })).status, 200);
	assert.deepEqual(sqlite.prepare("SELECT calendar_id FROM calendar_events ORDER BY id").all().map((row) => row.calendar_id), [calendar.id, calendar.id, calendar.id]);
	assert.equal((await patch({ calendarId: "cal:u1" })).status, 200);
	assert.deepEqual(sqlite.prepare("SELECT calendar_id FROM calendar_events").all().map((row) => row.calendar_id), [null, null, null]);
});

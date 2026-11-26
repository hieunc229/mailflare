import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calReview.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.calReview;return {user:s.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
};
const events = await loadFixture({ name: "cal-review-events", entryPoint: "src/app/api/calendar/events/route.ts", mocks });
const event = await loadFixture({ name: "cal-review-event", entryPoint: "src/app/api/calendar/events/[eventId]/route.ts", mocks });
const { GET: listEvents, POST: createEvent } = await events.import();
const { PATCH: patchEvent } = await event.import();
let sqlite;
let batches;
after(() => { sqlite?.close(); delete globalThis.calReview; events.dispose(); event.dispose(); });

function setup() {
	sqlite?.close();
	// A competing deleteCalendar: when a write batch reaches its calendar guard, the calendar's row is already gone.
	const beforeQuery = (query, db) => { globalThis.calReview?.sqls.push(query); if (globalThis.calReview?.race && /insert into "dav_sync_state"/i.test(query)) { globalThis.calReview.race = false; db.exec("DELETE FROM dav_collections WHERE id = 'cal:work'"); } };
	sqlite = installSqlite("calReview", { schema, beforeQuery, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, race: false, sqls: [] } });
	batches = [];
	globalThis.calReview.db.batch = async (statements) => {
		batches.push(statements.length);
		sqlite.exec("BEGIN");
		try { for (const statement of statements) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
	};
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1)");
}
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const addWeekly = (id, calendarId = null) => sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, repeat, created_at, updated_at) VALUES (?, 'u1', ?, 'Weekly', ?, ?, 'weekly', 1, 1)").run(id, calendarId, sec("2026-01-05T10:00:00Z"), sec("2026-01-05T11:00:00Z"));
const json = (body) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (id, body) => patchEvent(new Request("https://m.test/x", json({ title: "Weekly", startsAt: "2026-01-05T10:00:00.000Z", endsAt: "2026-01-05T11:00:00.000Z", repeat: "weekly", ...body })), { params: Promise.resolve({ eventId: id }) });
const calendars = () => sqlite.prepare("SELECT id, calendar_id FROM calendar_events ORDER BY id").all().map((row) => [row.id, row.calendar_id]);

test("GET shows an event whose calendar row is missing in the default calendar", async () => {
	setup();
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('orphan', 'u1', 'cal:gone', 'E', ?, ?, 1, 1)").run(sec("2026-12-01T10:00:00Z"), sec("2026-12-01T11:00:00Z"));
	const body = await (await listEvents(new Request("https://m.test/api/calendar/events?start=2026-12-01T00:00:00Z&end=2026-12-02T00:00:00Z"))).json();
	assert.deepEqual(body.events.map((item) => [item.id, item.calendarId]), [["orphan", "cal:u1"]]);
	const filtered = await (await listEvents(new Request("https://m.test/api/calendar/events?start=2026-12-01T00:00:00Z&end=2026-12-02T00:00:00Z&calendarIds=cal:u1"))).json();
	assert.equal(filtered.events.length, 1);
});

test("an event in a calendar whose row is missing stays editable when the editor sends that calendar back", async () => {
	setup();
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('orphan', 'u1', 'cal:gone', 'Old', ?, ?, 1, 1)").run(sec("2026-12-01T10:00:00Z"), sec("2026-12-01T11:00:00Z"));
	const response = await patchEvent(new Request("https://m.test/x", json({ title: "New", startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T11:00:00.000Z", calendarId: "cal:gone" })), { params: Promise.resolve({ eventId: "orphan" }) });
	assert.equal(response.status, 200);
	assert.equal(sqlite.prepare("SELECT title FROM calendar_events WHERE id = 'orphan'").get().title, "New");
});

test("a non-string calendarId on PATCH is 400", async () => {
	setup();
	addWeekly("w1");
	assert.equal((await patch("w1", { calendarId: 7 })).status, 400);
});

test("editing this and following with a new calendar moves the whole series: the cut-off part and the new series both land in it", async () => {
	setup();
	addWeekly("w1");
	const response = await patch("w1", { effectiveFrom: "2026-02-02T10:00:00.000Z", startsAt: "2026-02-02T12:00:00.000Z", endsAt: "2026-02-02T13:00:00.000Z", calendarId: "cal:work" });
	assert.equal(response.status, 200);
	const rows = calendars();
	assert.equal(rows.length, 2);
	assert.ok(rows.every(([, calendarId]) => calendarId === "cal:work"), JSON.stringify(rows));
});

test("moving one past occurrence with a new calendar moves the series and the occurrence", async () => {
	setup();
	addWeekly("w1");
	const occurrence = `w1@${Date.parse("2026-01-12T10:00:00Z")}`;
	const response = await patch(occurrence, { moveOccurrenceToPast: true, startsAt: "2026-01-13T10:00:00.000Z", endsAt: "2026-01-13T11:00:00.000Z", calendarId: "cal:work" });
	assert.equal(response.status, 200);
	const rows = calendars();
	assert.equal(rows.length, 2);
	assert.ok(rows.every(([, calendarId]) => calendarId === "cal:work"), JSON.stringify(rows));
});

test("the whole-series edit and the move to another calendar are one batch", async () => {
	setup();
	addWeekly("w1");
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, created_at, updated_at, dav_object_id, recurrence_id) VALUES ('o1', 'u1', 'Override', ?, ?, 'none', 1, 1, 'w1', ?)").run(sec("2026-01-12T10:00:00Z"), sec("2026-01-12T11:00:00Z"), sec("2026-01-12T10:00:00Z"));
	sqlite.prepare("UPDATE calendar_events SET dav_object_id = 'w1' WHERE id = 'w1'").run();
	const response = await patch("w1", { effectiveFrom: "2026-01-05T10:00:00.000Z", calendarId: "cal:work" });
	assert.equal(response.status, 200);
	assert.deepEqual(calendars(), [["o1", "cal:work"], ["w1", "cal:work"]]);
	assert.deepEqual(batches, [4], "the calendar guard (2), the edit and the move");
});

const postBody = (calendarId) => ({ title: "New", startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T11:00:00.000Z", calendarId });
const post = (calendarId) => createEvent(new Request("https://m.test/api/calendar/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(postBody(calendarId)) }));
const count = () => sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n;

test("an event created in a calendar that a competing delete just removed is refused with 409 and writes nothing", async () => {
	setup();
	globalThis.calReview.race = true;
	const response = await post("cal:work");
	assert.equal(response.status, 409);
	assert.equal(count(), 0);
	assert.equal((await post("cal:work")).status, 200);
	assert.equal(count(), 1);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_sync_state").get().n, 0, "no guard row is left behind");
});

test("creating in the default calendar needs no guard", async () => {
	setup();
	globalThis.calReview.race = true;
	assert.equal((await post(null)).status, 200);
	assert.equal(globalThis.calReview.race, true);
});

test("moving a series to a calendar that a competing delete just removed is 409 and moves nothing", async () => {
	setup();
	addWeekly("w1");
	globalThis.calReview.race = true;
	assert.equal((await patch("w1", { effectiveFrom: "2026-01-05T10:00:00.000Z", calendarId: "cal:work" })).status, 409);
	assert.deepEqual(calendars(), [["w1", null]]);
});

test("a this-and-following edit into a calendar that a competing delete just removed is 409 and splits nothing", async () => {
	setup();
	addWeekly("w1");
	globalThis.calReview.race = true;
	assert.equal((await patch("w1", { effectiveFrom: "2026-02-02T10:00:00.000Z", startsAt: "2026-02-02T12:00:00.000Z", endsAt: "2026-02-02T13:00:00.000Z", calendarId: "cal:work" })).status, 409);
	assert.deepEqual(calendars(), [["w1", null]]);
});

test("moving one past occurrence into a calendar that a competing delete just removed is 409 and writes nothing", async () => {
	setup();
	addWeekly("w1");
	globalThis.calReview.race = true;
	const occurrence = `w1@${Date.parse("2026-01-12T10:00:00Z")}`;
	assert.equal((await patch(occurrence, { moveOccurrenceToPast: true, startsAt: "2026-01-13T10:00:00.000Z", endsAt: "2026-01-13T11:00:00.000Z", calendarId: "cal:work" })).status, 409);
	assert.deepEqual(calendars(), [["w1", null]]);
	assert.equal(sqlite.prepare("SELECT excluded_occurrences AS e FROM calendar_events WHERE id = 'w1'").get().e, "[]");
});

test("listing events for a range reads calendar ids only, never counts events per calendar", async () => {
	setup();
	await listEvents(new Request("https://m.test/api/calendar/events?start=2026-12-01T00:00:00Z&end=2026-12-02T00:00:00Z"));
	const sqls = globalThis.calReview.sqls;
	assert.ok(sqls.some((query) => /from "dav_collections"/i.test(query)));
	assert.equal(sqls.filter((query) => /group by/i.test(query)).length, 0, sqls.join("\n"));
});

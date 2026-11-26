import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-4: UIDs and names are unique per CalDAV collection, so a web move can collide in the target calendar.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calMove.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.calMove;return {user:s.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
};
const route = await loadFixture({ name: "cal-move-event", entryPoint: "src/app/api/calendar/events/[eventId]/route.ts", mocks });
const utils = await loadFixture({ name: "cal-move-utils", entryPoint: "src/app/(calendar)/calendar/calendar-list-utils.ts", mocks: {} });
const { PATCH: patchEvent } = await route.import();
const { eventErrorKey } = await utils.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calMove; route.dispose(); utils.dispose(); });

function setup() {
	sqlite?.close();
	// A competing deleteCalendar: when a write batch reaches its calendar guard, the calendar's row is already gone.
	const beforeQuery = (query, db) => { if (globalThis.calMove?.race && /insert into "dav_sync_state"/i.test(query)) { globalThis.calMove.race = false; db.exec("DELETE FROM dav_collections WHERE id = 'cal:work'"); } };
	sqlite = installSqlite("calMove", { schema, beforeQuery, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, race: false } });
	globalThis.calMove.db.batch = async (statements) => {
		sqlite.exec("BEGIN");
		try { for (const statement of statements) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
	};
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1)");
}
const addEvent = (id, calendarId, uid, name) => {
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', ?, 'E', 1000, 2000, 1, 1)").run(id, calendarId);
	sqlite.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, 1, 1, 1)").run(id, calendarId ?? "cal:u1", name, uid);
};
const move = (id, calendarId) => patchEvent(new Request("https://m.test/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "E", startsAt: "2026-01-05T10:00:00.000Z", endsAt: "2026-01-05T11:00:00.000Z", calendarId }) }), { params: Promise.resolve({ eventId: id }) });
const where = (id) => sqlite.prepare("SELECT calendar_id FROM calendar_events WHERE id = ?").get(id).calendar_id;

test("a move into a calendar that already has the same UID is 409 EVENT_ID_EXISTS, not 'no longer exists', and moves nothing", async () => {
	setup();
	addEvent("a", null, "same-uid", "a.ics");
	addEvent("b", "cal:work", "same-uid", "b.ics");
	const response = await move("a", "cal:work");
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "An event with the same ID already exists in that calendar", code: "EVENT_ID_EXISTS" });
	assert.equal(where("a"), null);
	assert.equal(sqlite.prepare("SELECT collection_id FROM dav_calendar_objects WHERE id = 'a'").get().collection_id, "cal:u1");
});

test("the same for a name that is taken in the target calendar", async () => {
	setup();
	addEvent("a", null, "uid-a", "same.ics");
	addEvent("b", "cal:work", "uid-b", "same.ics");
	const response = await move("a", "cal:work");
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "EVENT_ID_EXISTS");
});

test("a move without a collision still works, and a calendar deleted meanwhile is still told apart", async () => {
	setup();
	addEvent("a", null, "uid-a", "a.ics");
	assert.equal((await move("a", "cal:work")).status, 200);
	assert.equal(where("a"), "cal:work");
	addEvent("c", null, "uid-c", "c.ics");
	sqlite.exec("DELETE FROM dav_collections WHERE id = 'cal:work'");
	const gone = await move("c", "cal:work");
	assert.equal(gone.status, 404, "a calendar that is gone is not found");
});

test("the editor maps the code to its own message, which every catalog has in English", () => {
	assert.equal(eventErrorKey(409, "EVENT_ID_EXISTS"), "calendar.calendars.error.eventIdExists");
	const text = "An event with the same ID already exists in that calendar.";
	const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
	assert.equal(en["calendar.calendars.error.eventIdExists"], text);
	for (const file of ["de", "fr", "ar", "bn"]) assert.equal(JSON.parse(readFileSync(new URL(`../public/locales/${file}.json`, import.meta.url), "utf8"))["calendar.calendars.error.eventIdExists"], text, file);
});

const addWeekly = (id) => sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, repeat, created_at, updated_at) VALUES (?, 'u1', 'cal:work', 'Weekly', ?, ?, 'weekly', 1, 1)").run(id, Math.floor(Date.parse("2026-01-05T10:00:00Z") / 1000), Math.floor(Date.parse("2026-01-05T11:00:00Z") / 1000));
const patchBody = (id, body) => patchEvent(new Request("https://m.test/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Weekly", startsAt: "2026-01-05T10:00:00.000Z", endsAt: "2026-01-05T11:00:00.000Z", repeat: "weekly", ...body }) }), { params: Promise.resolve({ eventId: id }) });

test("a this-and-following edit in a calendar deleted at that moment is 409 and writes nothing", async () => {
	setup();
	addWeekly("w1");
	globalThis.calMove.race = true;
	const response = await patchBody("w1", { effectiveFrom: "2026-02-02T10:00:00.000Z", startsAt: "2026-02-02T12:00:00.000Z", endsAt: "2026-02-02T13:00:00.000Z" });
	assert.equal(response.status, 409);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
});

test("moving one past occurrence in a calendar deleted at that moment is 409 and writes nothing", async () => {
	setup();
	addWeekly("w1");
	globalThis.calMove.race = true;
	const occurrence = `w1@${Date.parse("2026-01-12T10:00:00Z")}`;
	const response = await patchBody(occurrence, { moveOccurrenceToPast: true, startsAt: "2026-01-13T10:00:00.000Z", endsAt: "2026-01-13T11:00:00.000Z" });
	assert.equal(response.status, 409);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
	assert.equal(sqlite.prepare("SELECT excluded_occurrences FROM calendar_events WHERE id = 'w1'").get().excluded_occurrences, "[]");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-4 review: a moved occurrence (an override row of a CalDAV series) belongs to its series, so moving it moves the series.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calOverride.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.calOverride;return {user:s.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
};
const route = await loadFixture({ name: "cal-override-event", entryPoint: "src/app/api/calendar/events/[eventId]/route.ts", mocks });
const utils = await loadFixture({ name: "cal-override-utils", entryPoint: "src/app/(calendar)/calendar/calendar-list-utils.ts", mocks: {} });
const { PATCH: patchEvent } = await route.import();
const { movesSeries } = await utils.import();
let sqlite;
let current;
after(() => { sqlite?.close(); delete globalThis.calOverride; route.dispose(); utils.dispose(); });

/** u1 owns "Work" (cal:work); a CalDAV series m1 with a moved occurrence o1 lives in it; u2 reads it, u3 edits it. */
function setup(user = "u1") {
	sqlite?.close();
	current = user;
	sqlite = installSqlite("calOverride", { schema, extra: { user: { id: user, timeZone: "UTC", calendarEnabled: true } } });
	globalThis.calOverride.db.batch = async (statements) => {
		sqlite.exec("BEGIN");
		try { for (const statement of statements) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
	};
	for (const id of ["u1", "u2", "u3"]) sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'x', 'user', 1)").run(id, `${id}@one.test`, id);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1), ('cal:other', 'u1', 'calendar', 'Other', 1, 1), ('cal:u2own', 'u2', 'calendar', 'Mine', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('csh_r', 'cal:work', 'u2', 'read', 1), ('csh_e', 'cal:work', 'u3', 'edit', 1), ('csh_e2', 'cal:other', 'u3', 'read', 1)");
	sqlite.exec("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, repeat, dav_object_id, created_at, updated_at) VALUES ('m1', 'u1', 'cal:work', 'Series', 1000, 2000, 'weekly', 'm1', 1, 1)");
	sqlite.exec("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, dav_object_id, recurrence_id, created_at, updated_at) VALUES ('o1', 'u1', 'cal:work', 'Moved occurrence', 5000, 6000, 'm1', 3000, 1, 1)");
	sqlite.exec("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('m1', 'u1', 'cal:work', 'm1.ics', 'uid-m1', 1, 1, 1)");
}
const move = (id, calendarId) => patchEvent(new Request("https://m.test/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Moved occurrence", startsAt: "2026-01-05T10:00:00.000Z", endsAt: "2026-01-05T11:00:00.000Z", calendarId }) }), { params: Promise.resolve({ eventId: id }) });
const calendars = () => sqlite.prepare("SELECT id, calendar_id FROM calendar_events ORDER BY id").all().map((row) => [row.id, row.calendar_id]);
const log = (collection) => sqlite.prepare("SELECT object_key, change_type FROM dav_changes WHERE collection_id = ? ORDER BY seq").all(collection).map((row) => `${row.object_key}:${row.change_type}`);

test("moving a moved occurrence on its own moves the whole series, and the old collection's phones are told it is gone", async () => {
	setup();
	const before = log("cal:work").length;
	assert.equal((await move("o1", "cal:other")).status, 200);
	assert.deepEqual(calendars(), [["m1", "cal:other"], ["o1", "cal:other"]]);
	assert.equal(sqlite.prepare("SELECT collection_id FROM dav_calendar_objects WHERE id = 'm1'").get().collection_id, "cal:other");
	assert.ok(log("cal:work").slice(before).includes("m1:destroyed"), `the series is dropped from the old collection: ${log("cal:work")}`);
	assert.ok(log("cal:other").includes("m1:created"));
});

test("moving it to the default calendar moves the series there", async () => {
	setup();
	assert.equal((await move("o1", "cal:u1")).status, 200);
	assert.deepEqual(calendars(), [["m1", null], ["o1", null]]);
});

test("the role is checked on the series' calendar: a delegate who may only read the target or the series is refused and nothing moves", async () => {
	setup("u3");
	// u3 edits Work but only reads Other.
	assert.equal((await move("o1", "cal:other")).status, 403);
	assert.deepEqual(calendars(), [["m1", "cal:work"], ["o1", "cal:work"]]);
	// An editor of Work may move the series into another calendar of the same owner they can edit: here the owner's default is not theirs.
	assert.equal((await move("o1", "cal:u1")).status, 404);
	assert.deepEqual(calendars(), [["m1", "cal:work"], ["o1", "cal:work"]]);
});

test("a reader of the series' calendar cannot move its occurrence", async () => {
	setup("u2");
	assert.equal((await move("o1", "cal:u2own")).status, 403);
	assert.deepEqual(calendars(), [["m1", "cal:work"], ["o1", "cal:work"]]);
});

test("the editor says the whole series moves for a moved occurrence too", () => {
	assert.equal(movesSeries({ id: "m1", repeat: "weekly", davObjectId: "m1" }), true);
	assert.equal(movesSeries({ id: "o1", repeat: "none", davObjectId: "m1" }), true);
	assert.equal(movesSeries({ id: "x", repeat: "none", davObjectId: null }), false);
	assert.equal(movesSeries({ id: "x", repeat: "none" }), false);
});

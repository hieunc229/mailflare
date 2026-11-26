import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calShareEv.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.calShareEv;return s.user?{user:s.user,key:null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.calShareEv.audit.push(input)}",
	"@/lib/email/send": "export async function sendEmail(env,input){globalThis.calShareEv.sent.push(input)}",
};
const load = (name, entryPoint) => loadFixture({ name, entryPoint, mocks });
const fixtures = [await load("cal-share-events", "src/app/api/calendar/events/route.ts"), await load("cal-share-event", "src/app/api/calendar/events/[eventId]/route.ts")];
const [{ GET: listEvents, POST: createEvent }, { PATCH: patchEvent, DELETE: deleteEvent }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calShareEv; for (const fixture of fixtures) fixture.dispose(); });

// u1 owns the default calendar and "cal:work"; u2 edit, u3 read, u4 free/busy, u5 manage on cal:work; u6 has no grant.
function setup() {
	sqlite?.close();
	sqlite = installSqlite("calShareEv", { schema, extra: { user: null, audit: [], sent: [] } });
	globalThis.calShareEv.db.batch = async (statements) => {
		sqlite.exec("BEGIN");
		try { for (const statement of statements) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
	};
	for (let index = 1; index <= 7; index += 1) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u${index}', 'u${index}@one.test', 'User ${index}', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'one.test', 'z', 1)");
	sqlite.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx_owner', 'u1', 'd1', 'owner', 'personal', 1)");
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1), ('cal:home', 'u1', 'calendar', 'Home', 1, 1), ('cal:theirs', 'u7', 'calendar', 'Theirs', 1, 1), ('cal:mine6', 'u6', 'calendar', 'Mine', 1, 1)");
	for (const [id, user, role] of [["g2", "u2", "edit"], ["g3", "u3", "read"], ["g4", "u4", "freebusy"], ["g5", "u5", "manage"]]) sqlite.exec(`INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('${id}', 'cal:work', '${user}', '${role}', 1)`);
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g2h', 'cal:home', 'u2', 'edit', 1), ('g2t', 'cal:theirs', 'u2', 'edit', 1), ('g3t', 'cal:theirs', 'u3', 'read', 1)");
	as("u1");
}
const as = (id) => { globalThis.calShareEv.user = id ? { id, timeZone: "UTC", calendarEnabled: true } : null; };
const audit = () => globalThis.calShareEv.audit;
const sent = () => globalThis.calShareEv.sent;
const sec = (iso) => Date.parse(iso) / 1000;
const add = (id, { user = "u1", calendar = null, title = "Secret", extra = "", start = "2026-12-01T10:00:00Z" } = {}) =>
	sqlite.prepare(`INSERT INTO calendar_events (id, user_id, calendar_id, title, description, location, attendees, mailbox_id, reminder_minutes, starts_at, ends_at, created_at, updated_at${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, ?, ?, ?, 'private notes', 'Room 1', '["g@x.co"]', 'mbx_owner', 15, ?, ?, 1, 1${extra ? ", " + extra.split("=")[1] : ""})`).run(id, user, calendar, title, sec(start), sec(start) + 3600);
const json = (body, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const eventParams = (eventId) => ({ params: Promise.resolve({ eventId }) });
const body = (extra = {}) => ({ title: "Plan", startsAt: "2026-12-02T10:00:00.000Z", endsAt: "2026-12-02T11:00:00.000Z", ...extra });
const list = async (query = "") => (await (await listEvents(new Request(`https://m.test/api/calendar/events?start=2026-11-30T00:00:00Z&end=2026-12-31T00:00:00Z${query}`))).json()).events;
const create = (extra) => createEvent(new Request("https://m.test/api/calendar/events", json(body(extra))));
const patch = (id, extra) => patchEvent(new Request(`https://m.test/api/calendar/events/${id}`, json(body(extra), "PATCH")), eventParams(id));
const remove = (id, extra) => deleteEvent(new Request(`https://m.test/api/calendar/events/${id}`, json(extra ?? {}, "DELETE")), eventParams(id));
const row = (id) => sqlite.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id);
const count = () => sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n;

// ---- list -----------------------------------------------------------------------------------------------------------

test("GET lists shared calendars' events to a grantee, with the role, and never an unshared calendar's", async () => {
	setup();
	add("w1", { calendar: "cal:work", title: "Standup" }); add("h1", { calendar: "cal:home", title: "Home thing" }); add("d1", { title: "Default" }); add("o1", { user: "u2", title: "Mine" });
	as("u3");
	const events = await list();
	assert.deepEqual(events.map((event) => [event.id, event.role]).sort(), [["w1", "read"]]);
	assert.equal(events[0].calendarId, "cal:work");
	assert.equal(events[0].title, "Standup");
	as("u2");
	assert.deepEqual((await list()).map((event) => [event.id, event.role]).sort(), [["h1", "edit"], ["o1", "owner"], ["w1", "edit"]]);
	as("u6");
	assert.deepEqual(await list(), []);
	assert.deepEqual(await list("&calendarIds=cal:work,cal:home"), [], "naming a calendar there is no grant on shows nothing");
});

test("GET redacts private events server-side for a reader and never gives a non-owner the owner's mailbox or reminder", async () => {
	setup();
	add("p1", { calendar: "cal:work", extra: "is_private=1" }); add("n1", { calendar: "cal:work", title: "Open" });
	as("u3");
	const events = Object.fromEntries((await list()).map((event) => [event.id, event]));
	assert.deepEqual([events.p1.title, events.p1.description, events.p1.location, events.p1.attendees, events.p1.redacted, events.p1.mailboxId, events.p1.reminderMinutes], ["Busy", "", "", "[]", true, null, null]);
	assert.deepEqual([events.n1.title, events.n1.description, events.n1.mailboxId, events.n1.reminderMinutes], ["Open", "private notes", null, null]);
	as("u2");
	assert.equal((await list()).find((event) => event.id === "p1").title, "Secret", "editors see private details");
	as("u1");
	const own = (await list()).find((event) => event.id === "p1");
	assert.deepEqual([own.title, own.mailboxId, own.reminderMinutes, own.role], ["Secret", "mbx_owner", 15, "owner"]);
});

test("GET gives a free/busy grantee blocks only, and only when the calendar is named", async () => {
	setup();
	add("w1", { calendar: "cal:work", title: "Standup" }); add("w2", { calendar: "cal:work", extra: "transparent=1" }); add("w3", { calendar: "cal:work", extra: "response_status='declined'" });
	as("u4");
	assert.deepEqual(await list(), [], "a free/busy grant is not a calendar to show");
	const blocks = await list("&calendarIds=cal:work");
	assert.deepEqual(blocks.map((event) => event.id), ["w1"], "free, declined and unanswered events are not busy time");
	assert.deepEqual([blocks[0].title, blocks[0].description, blocks[0].location, blocks[0].attendees, blocks[0].redacted, blocks[0].role], ["Busy", "", "", "[]", true, "freebusy"]);
});

test("GET reads a shared default calendar: the owner's events without a calendar, and nobody else's", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:u1', 'u1', 'calendar', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('gd', 'cal:u1', 'u6', 'read', 1)");
	add("d1", { title: "Default" }); add("w1", { calendar: "cal:work" }); add("x1", { user: "u7", title: "Other user's default" });
	as("u6");
	assert.deepEqual((await list()).map((event) => event.id), ["d1"]);
	assert.deepEqual((await list("&calendarIds=cal:u1")).map((event) => [event.id, event.calendarId]), [["d1", "cal:u1"]]);
});

test("GET leaves the owner's unanswered, declined and cancelled invitations out of what a grantee sees", async () => {
	setup();
	add("ok", { calendar: "cal:work" }); add("na", { calendar: "cal:work", extra: "response_status='needs-action'" }); add("dc", { calendar: "cal:work", extra: "response_status='declined'" }); add("cx", { calendar: "cal:work", extra: "response_status='cancelled'" }); add("acc", { calendar: "cal:work", extra: "response_status='accepted'" });
	as("u2");
	assert.deepEqual((await list()).map((event) => event.id).sort(), ["acc", "ok"]);
	as("u1");
	assert.equal((await list()).length, 5, "the owner still sees all of them");
});

// ---- create ---------------------------------------------------------------------------------------------------------

test("POST by an editor writes into the owner's calendar as the owner's row, audits the delegate, and sets no reminder or mailbox", async () => {
	setup();
	as("u2");
	const response = await create({ calendarId: "cal:work", reminderMinutes: 30, mailboxId: "mbx_other" });
	assert.equal(response.status, 200);
	const { event } = await response.json();
	const stored = row(event.id);
	assert.deepEqual([stored.user_id, stored.calendar_id, stored.reminder_minutes, stored.mailbox_id], ["u1", "cal:work", null, null]);
	assert.equal(event.userId, "u1");
	assert.equal(audit().length, 1);
	assert.deepEqual([audit()[0].action, audit()[0].actorUserId, audit()[0].targetUserId, audit()[0].metadata.calendarId, audit()[0].metadata.eventId], ["calendar.event_created_by_delegate", "u2", "u1", "cal:work", event.id]);
	assert.equal(JSON.stringify(audit()[0]).includes("Plan"), false, "the audit entry never carries the event's title");
	assert.equal(sent().length, 0);
});

test("POST by an editor with attendees is refused with INVITE_REQUIRES_OWNER and writes nothing; a manager is no different", async () => {
	setup();
	for (const user of ["u2", "u5"]) {
		as(user);
		const response = await create({ calendarId: "cal:work", attendees: ["guest@x.co"], mailboxId: "mbx", from: "o@x.co" });
		assert.equal(response.status, 403);
		assert.equal((await response.json()).code, "INVITE_REQUIRES_OWNER");
	}
	assert.equal(count(), 0);
	assert.equal(sent().length, 0);
	assert.equal(audit().length, 0);
	as("u1");
	assert.equal((await create({ calendarId: "cal:work", attendees: ["guest@x.co"] })).status, 200, "the owner still invites");
});

test("POST needs edit: a reader is 403, a free/busy grantee, a stranger and a missing calendar are the same 404", async () => {
	setup();
	as("u3");
	assert.equal((await create({ calendarId: "cal:work" })).status, 403);
	as("u4");
	const hidden = await create({ calendarId: "cal:work" });
	as("u6");
	const stranger = await create({ calendarId: "cal:work" });
	const missing = await create({ calendarId: "cal:nope" });
	assert.deepEqual([hidden.status, stranger.status, missing.status], [404, 404, 404]);
	assert.deepEqual(await stranger.json(), await missing.json());
	assert.equal(count(), 0);
	assert.equal(audit().length, 0);
});

test("POST into somebody's default calendar: refused until that default has a row and a grant", async () => {
	setup();
	as("u2");
	assert.equal((await create({ calendarId: "cal:u1" })).status, 404);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:u1', 'u1', 'calendar', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('gd', 'cal:u1', 'u2', 'edit', 1)");
	const response = await create({ calendarId: "cal:u1" });
	assert.equal(response.status, 200);
	const stored = row((await response.json()).event.id);
	assert.deepEqual([stored.user_id, stored.calendar_id], ["u1", null], "the default calendar is stored as no calendar");
});

test("POST by the owner into their own calendar is not audited", async () => {
	setup();
	assert.equal((await create({ calendarId: "cal:work" })).status, 200);
	assert.equal(audit().length, 0);
});

// ---- update ---------------------------------------------------------------------------------------------------------

test("PATCH by an editor changes the owner's event, keeps the owner's reminder, mailbox and guests, and audits the delegate", async () => {
	setup();
	add("w1", { calendar: "cal:work" });
	as("u2");
	const response = await patch("w1", { title: "Renamed", attendees: ["g@x.co"], reminderMinutes: null, mailboxId: null });
	assert.equal(response.status, 200);
	const stored = row("w1");
	assert.deepEqual([stored.title, stored.user_id, stored.reminder_minutes, stored.mailbox_id, stored.attendees], ["Renamed", "u1", 15, "mbx_owner", '["g@x.co"]']);
	assert.deepEqual([audit()[0].action, audit()[0].actorUserId, audit()[0].targetUserId, audit()[0].metadata.eventId], ["calendar.event_updated_by_delegate", "u2", "u1", "w1"]);
	assert.equal(sent().length, 0, "a delegate's edit sends no invitation update");
});

test("PATCH by an editor cannot change the guest list", async () => {
	setup();
	add("w1", { calendar: "cal:work" });
	as("u2");
	for (const attendees of [["g@x.co", "new@x.co"], [], ["other@x.co"]]) {
		const response = await patch("w1", { attendees });
		assert.equal(response.status, 403);
		assert.equal((await response.json()).code, "INVITE_REQUIRES_OWNER");
	}
	assert.equal(row("w1").title, "Secret");
	assert.equal(audit().length, 0);
});

test("PATCH: a reader is 403, a free/busy grantee, a stranger and a missing event are the same 404, and nothing changes", async () => {
	setup();
	add("w1", { calendar: "cal:work" });
	as("u3");
	assert.equal((await patch("w1", { attendees: ["g@x.co"] })).status, 403);
	as("u4");
	const blocked = await patch("w1");
	as("u6");
	const stranger = await patch("w1");
	const missing = await patch("nope");
	assert.deepEqual([blocked.status, stranger.status, missing.status], [404, 404, 404]);
	assert.deepEqual(await stranger.json(), await missing.json());
	assert.equal(row("w1").title, "Secret");
	assert.equal(audit().length, 0);
});

test("PATCH takes effect for a revoke immediately: the next request from the former editor is 404", async () => {
	setup();
	add("w1", { calendar: "cal:work" });
	as("u2");
	assert.equal((await patch("w1", { attendees: ["g@x.co"], title: "A" })).status, 200);
	sqlite.exec("DELETE FROM calendar_shares WHERE id = 'g2'");
	assert.equal((await patch("w1", { attendees: ["g@x.co"], title: "B" })).status, 404);
	assert.equal(row("w1").title, "A");
});

test("PATCH an event whose row names a calendar of another owner is out of reach (the owner invariant)", async () => {
	setup();
	add("odd", { user: "u7", calendar: "cal:work" });
	as("u2");
	assert.equal((await patch("odd")).status, 404);
	assert.equal(row("odd").title, "Secret");
});

test("PATCH moves an event between two calendars of the same owner when the actor can edit both; the row stays the owner's", async () => {
	setup();
	add("w1", { calendar: "cal:work" });
	as("u2");
	assert.equal((await patch("w1", { attendees: ["g@x.co"], calendarId: "cal:home" })).status, 200);
	assert.deepEqual([row("w1").calendar_id, row("w1").user_id], ["cal:home", "u1"]);
	assert.equal(audit()[0].metadata.calendarId, "cal:home");
});

test("PATCH refuses a move that needs a role the actor lacks on either side, or another owner's calendar", async () => {
	setup();
	add("w1", { calendar: "cal:work" }); add("t1", { user: "u7", calendar: "cal:theirs" });
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g2m', 'cal:mine6', 'u2', 'read', 1)");
	as("u2");
	// Editor on source, nothing on a stranger's calendar: 404 like any unseen calendar.
	assert.equal((await patch("w1", { attendees: ["g@x.co"], calendarId: "cal:nope" })).status, 404);
	// Read on the target: they can see it but not write to it.
	assert.equal((await patch("w1", { attendees: ["g@x.co"], calendarId: "cal:mine6" })).status, 403);
	// Edit on both, but different owners: refused (spec 8.4).
	assert.equal((await patch("w1", { attendees: ["g@x.co"], calendarId: "cal:theirs" })).status, 400);
	// Moving to their own default calendar would hand the owner's event to the actor: refused.
	assert.equal((await patch("w1", { attendees: ["g@x.co"], calendarId: "cal:u2" })).status, 400);
	assert.deepEqual([row("w1").calendar_id, row("w1").user_id], ["cal:work", "u1"]);
	// A reader on the source cannot move out of it.
	as("u3");
	assert.equal((await patch("t1", { attendees: ["g@x.co"], calendarId: "cal:work" })).status, 403);
	assert.equal(audit().length, 0);
	// The owner cannot pull an event into a calendar that only someone else owns (they hold an edit grant on it).
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1t', 'cal:theirs', 'u1', 'edit', 1)");
	as("u1");
	assert.equal((await patch("w1", { attendees: ["g@x.co"], calendarId: "cal:theirs" })).status, 400);
	assert.equal(row("w1").user_id, "u1");
});

test("PATCH by an editor on a series: a past occurrence moved and a this-and-following split stay the owner's rows, in the owner's calendar", async () => {
	setup();
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, attendees, starts_at, ends_at, repeat, dav_object_id, created_at, updated_at) VALUES ('s1', 'u1', 'cal:work', 'Weekly', '[]', ?, ?, 'weekly', 's1', 1, 1)").run(sec("2026-01-05T10:00:00Z"), sec("2026-01-05T11:00:00Z"));
	as("u2");
	const occurrence = `s1@${Date.parse("2026-01-12T10:00:00Z")}`;
	assert.equal((await patch(occurrence, { moveOccurrenceToPast: true, startsAt: "2026-01-13T10:00:00.000Z", endsAt: "2026-01-13T11:00:00.000Z" })).status, 200);
	assert.equal((await patch("s1", { effectiveFrom: "2026-02-02T10:00:00.000Z", startsAt: "2026-02-02T12:00:00.000Z", endsAt: "2026-02-02T13:00:00.000Z" })).status, 200);
	const rows = sqlite.prepare("SELECT id, user_id, calendar_id FROM calendar_events ORDER BY id").all();
	assert.ok(rows.length >= 3, JSON.stringify(rows));
	assert.ok(rows.every((entry) => entry.user_id === "u1" && entry.calendar_id === "cal:work"), JSON.stringify(rows));
	assert.equal(audit().filter((entry) => entry.action === "calendar.event_updated_by_delegate").length, 2);
});

// ---- delete ---------------------------------------------------------------------------------------------------------

test("DELETE by an editor removes the owner's event and its override rows, and audits the delegate", async () => {
	setup();
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, repeat, dav_object_id, created_at, updated_at) VALUES ('s1', 'u1', 'cal:work', 'Weekly', ?, ?, 'weekly', 's1', 1, 1)").run(sec("2026-01-05T10:00:00Z"), sec("2026-01-05T11:00:00Z"));
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, dav_object_id, recurrence_id, created_at, updated_at) VALUES ('s1o', 'u1', 'cal:work', 'Override', ?, ?, 's1', ?, 1, 1)").run(sec("2026-01-12T10:00:00Z"), sec("2026-01-12T11:00:00Z"), sec("2026-01-12T10:00:00Z"));
	add("keep", { calendar: "cal:work" });
	as("u2");
	assert.equal((await remove("s1")).status, 200);
	assert.deepEqual(sqlite.prepare("SELECT id FROM calendar_events ORDER BY id").all().map((entry) => entry.id), ["keep"]);
	assert.deepEqual([audit()[0].action, audit()[0].actorUserId, audit()[0].targetUserId, audit()[0].metadata.eventId], ["calendar.event_deleted_by_delegate", "u2", "u1", "s1"]);
});

test("DELETE: a reader is 403; a free/busy grantee, a stranger and a missing event get the same 404; the owner's delete is not audited", async () => {
	setup();
	add("w1", { calendar: "cal:work" });
	as("u3");
	assert.equal((await remove("w1")).status, 403);
	as("u4");
	const blocked = await remove("w1");
	as("u6");
	const stranger = await remove("w1");
	const missing = await remove("nope");
	assert.deepEqual([blocked.status, stranger.status, missing.status], [404, 404, 404]);
	assert.deepEqual(await stranger.json(), await missing.json());
	assert.equal(count(), 1);
	as("u1");
	assert.equal((await remove("w1")).status, 200);
	assert.equal(audit().length, 0);
});

test("DELETE of a single occurrence in a series by an editor ends the owner's series; still audited", async () => {
	setup();
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, repeat, created_at, updated_at) VALUES ('s1', 'u1', 'cal:work', 'Weekly', ?, ?, 'weekly', 1, 1)").run(sec("2026-01-05T10:00:00Z"), sec("2026-01-05T11:00:00Z"));
	as("u2");
	assert.equal((await remove("s1", { effectiveFrom: "2026-02-02T10:00:00.000Z" })).status, 200);
	assert.notEqual(row("s1").repeat_until, null);
	assert.equal(audit()[0].action, "calendar.event_deleted_by_delegate");
});

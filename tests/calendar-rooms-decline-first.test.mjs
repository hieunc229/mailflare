import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// m-3: on a driver whose batch is separate statements (Neon over HTTP) a crash between two of them must fail closed, so the decline of an
// event's bookings runs before the statement that moves the event. Each test crashes the batch just before the event is written.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomDf.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){return {user:globalThis.roomDf.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:true}}",
	"./confirmation": "export const CONFIRMED_CALENDAR_TOOLS=new Set(['update_events','delete_events']); export async function createCalendarConfirmation(){return 'x'}",
};
const fixtures = [await loadFixture({ name: "room-df-route", entryPoint: "src/app/api/calendar/events/[eventId]/route.ts", mocks }), await loadFixture({ name: "room-df-tools", entryPoint: "src/lib/calendar/tools.ts", mocks }), await loadFixture({ name: "room-df-invite", entryPoint: "src/lib/calendar/invite-store.ts", mocks })];
const [{ PATCH: patchEvent }, { runCalendarTool }, { registerInboundInvite, inviteEventId }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
let armed = false;
after(() => { sqlite?.close(); delete globalThis.roomDf; for (const fixture of fixtures) fixture.dispose(); });

const DAY = 86_400_000;
const H = 3_600_000;
const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const iso = (days, hours = 0) => new Date(FUTURE + days * DAY + hours * H).toISOString();
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function setup({ repeat = "none" } = {}) {
	sqlite?.close();
	armed = false;
	// Statements run one by one with no transaction, as on Neon over HTTP; a crash leaves what already ran.
	sqlite = installSqlite("roomDf", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true } }, beforeQuery: (sql) => { if (armed && /^(insert into|update) "calendar_events"/i.test(sql)) throw new Error("crash before the event is written"); } });
	globalThis.roomDf.db.batchIsAtomic = false;
	globalThis.roomDf.db.batch = async (list) => { armed = true; try { for (const statement of list) await statement; } finally { armed = false; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, time_zone, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 'UTC', 1)");
	sqlite.exec("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'one.test', 'z', 1)");
	sqlite.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, time_zone, created_at, updated_at) VALUES ('e1', 'u1', 'Standup', ?, ?, ?, 'UTC', 1, 1)").run(Math.floor((FUTURE + 9 * H) / 1000), Math.floor((FUTURE + 10 * H) / 1000), repeat);
	sqlite.exec("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', 'e1', 'accepted', 1)");
}
const status = (id = "e1") => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").get(id)?.status;
const startOf = (id = "e1") => sqlite.prepare("SELECT starts_at FROM calendar_events WHERE id = ?").get(id).starts_at;
const patch = (id, body) => patchEvent(new Request(`https://m.test/api/calendar/events/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Standup", startsAt: iso(0, 9), endsAt: iso(0, 10), ...body }) }), { params: Promise.resolve({ eventId: id }) });
const crashed = (promise) => assert.rejects(() => promise, /crash before the event is written|Failed query/);

test("web PATCH: a crash before the event is written has already declined its bookings (edit, split, moved occurrence)", async () => {
	setup();
	await crashed(patch("e1", { startsAt: iso(0, 13), endsAt: iso(0, 14) }));
	assert.equal(status(), "declined");
	assert.equal(startOf(), Math.floor((FUTURE + 9 * H) / 1000), "the event itself was not written");
	setup({ repeat: "weekly" });
	await crashed(patch("e1", { repeat: "weekly", effectiveFrom: iso(14, 9), startsAt: iso(14, 13), endsAt: iso(14, 14) }));
	assert.equal(status(), "declined");
	setup({ repeat: "weekly" });
	const past = new Date(Date.now() - 3 * DAY);
	await crashed(patch(`e1@${FUTURE + 7 * DAY + 9 * H}`, { moveOccurrenceToPast: true, startsAt: past.toISOString(), endsAt: new Date(past.getTime() + H).toISOString() }));
	assert.equal(status(), "declined");
});

test("MCP update: the same", async () => {
	setup();
	const context = { env: {}, user: { id: "u1", calendarEnabled: true, timeZone: "UTC" }, confirmed: true, timeZone: "UTC" };
	await crashed(runCalendarTool(context, "update_events", { updates: [{ eventId: "e1", startsAt: iso(0, 13), endsAt: iso(0, 14) }] }));
	assert.equal(status(), "declined");
	assert.equal(startOf(), Math.floor((FUTURE + 9 * H) / 1000));
});

test("invitation update and cancelled occurrence: the same", async () => {
	setup();
	sqlite.exec("DELETE FROM calendar_events; DELETE FROM calendar_resource_bookings");
	const invite = (start, end, sequence, extra = "", method = "REQUEST") => ["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", "UID:meeting-1@host.test", `SEQUENCE:${sequence}`, `DTSTAMP:${stamp(FUTURE)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, "SUMMARY:Review", "ORGANIZER:mailto:boss@host.test", extra, "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
	const receive = (body) => registerInboundInvite({}, { userId: "u1", mailboxId: "m1", messageId: "msg", senderAddress: "boss@host.test", attachments: [{ filename: "invite.ics", type: "text/calendar", content: new TextEncoder().encode(body).buffer }] });
	await receive(invite(FUTURE + 9 * H, FUTURE + 10 * H, 0));
	const id = await inviteEventId("u1", "meeting-1@host.test");
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', ?, 'accepted', 1)").run(id);
	await receive(invite(FUTURE + 13 * H, FUTURE + 14 * H, 1));
	assert.equal(status(id), "declined", "moved by an updated invitation");
	assert.equal(startOf(id), Math.floor((FUTURE + 9 * H) / 1000), "the crash stopped the event itself");
	sqlite.prepare("UPDATE calendar_resource_bookings SET status = 'accepted', conflict_at = NULL").run();
	sqlite.prepare("UPDATE calendar_events SET repeat = 'weekly' WHERE id = ?").run(id);
	await receive(invite(FUTURE + 7 * DAY + 9 * H, FUTURE + 7 * DAY + 10 * H, 1, `RECURRENCE-ID:${stamp(FUTURE + 7 * DAY + 9 * H)}`, "CANCEL"));
	assert.equal(status(id), "declined", "an occurrence cancelled by the organiser");
});

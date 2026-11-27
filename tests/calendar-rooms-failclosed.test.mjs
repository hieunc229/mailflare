import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// I-1: the room step may never run after the event is written (the process dies). The event's own batch must already have declined its bookings.
// After the first committed batch every further query throws, so neither the room step nor its own fail-closed fallback can run.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomFc.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.roomFc;return {user:s.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:true}}",
	"./confirmation": "export const CONFIRMED_CALENDAR_TOOLS=new Set(['update_events','delete_events']); export async function createCalendarConfirmation(){return 'x'}",
};
const fixtures = [await loadFixture({ name: "room-fc-route", entryPoint: "src/app/api/calendar/events/[eventId]/route.ts", mocks }), await loadFixture({ name: "room-fc-tools", entryPoint: "src/lib/calendar/tools.ts", mocks })];
const [{ PATCH: patchEvent }, { runCalendarTool }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
let dead = false;
after(() => { sqlite?.close(); delete globalThis.roomFc; for (const fixture of fixtures) fixture.dispose(); });

const DAY = 86_400_000;
const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const iso = (days, hours = 0) => new Date(FUTURE + days * DAY + hours * 3_600_000).toISOString();

function setup(extra = {}) {
	sqlite?.close();
	dead = false;
	sqlite = installSqlite("roomFc", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true } }, beforeQuery: () => { if (dead) throw new Error("process died"); } });
	globalThis.roomFc.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } dead = true; };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	const row = { id: "e1", repeat: "none", ...extra };
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, time_zone, created_at, updated_at) VALUES ('e1', 'u1', 'Standup', ?, ?, ?, 'UTC', 1, 1)").run(Math.floor((FUTURE + 9 * 3_600_000) / 1000), Math.floor((FUTURE + 10 * 3_600_000) / 1000), row.repeat);
	sqlite.exec("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', 'e1', 'accepted', 1)");
}
const status = () => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = 'e1'").get()?.status;
const patch = (id, body) => patchEvent(new Request(`https://m.test/api/calendar/events/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Standup", startsAt: iso(0, 9), endsAt: iso(0, 10), ...body }) }), { params: Promise.resolve({ eventId: id }) });

test("web: a time change that dies before the room step leaves the booking declined, not accepted at a time nobody checked", async () => {
	setup();
	await assert.rejects(() => patch("e1", { startsAt: iso(0, 13), endsAt: iso(0, 14) }), /Failed query|process died/);
	assert.equal(sqlite.prepare("SELECT starts_at FROM calendar_events WHERE id = 'e1'").get().starts_at, Math.floor((FUTURE + 13 * 3_600_000) / 1000), "the event was written");
	assert.equal(status(), "declined");
});

test("web: the same for a rule change, a split of a series and a moved occurrence", async () => {
	setup({ repeat: "weekly" });
	await assert.rejects(() => patch("e1", { repeat: "daily" }), /Failed query|process died/);
	assert.equal(status(), "declined");
	setup({ repeat: "weekly" });
	await assert.rejects(() => patch("e1", { repeat: "weekly", effectiveFrom: iso(14, 9), startsAt: iso(14, 13), endsAt: iso(14, 14) }), /Failed query|process died/);
	assert.equal(status(), "declined", "the old series");
	setup({ repeat: "weekly" });
	const past = new Date(Date.now() - 3 * DAY);
	await assert.rejects(() => patch(`e1@${FUTURE + 7 * DAY + 9 * 3_600_000}`, { moveOccurrenceToPast: true, startsAt: past.toISOString(), endsAt: new Date(past.getTime() + 3_600_000).toISOString() }), /Failed query|process died/);
	assert.equal(status(), "declined");
});

test("web: an event with no rooms is saved as before (no extra batch)", async () => {
	setup();
	sqlite.exec("DELETE FROM calendar_resource_bookings");
	let batches = 0;
	const real = globalThis.roomFc.db.batch;
	globalThis.roomFc.db.batch = async (list) => { batches += 1; return real(list); };
	assert.equal((await patch("e1", { title: "Renamed" })).status, 200);
	assert.equal(batches, 0, "no rooms, no batch: saved exactly as before");
});

test("MCP: an update that dies before the room step leaves the booking declined", async () => {
	setup();
	const context = { env: {}, user: { id: "u1", calendarEnabled: true, timeZone: "UTC" }, confirmed: true, timeZone: "UTC" };
	await runCalendarTool(context, "update_events", { updates: [{ eventId: "e1", startsAt: iso(0, 13), endsAt: iso(0, 14) }] }).catch(() => {});
	assert.equal(status(), "declined", "the room step never ran, so only the event's own batch can have declined it");
});

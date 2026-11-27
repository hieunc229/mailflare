import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// A save whose batch is refused (409) on a driver whose batch is separate statements has already run the decline that comes first: the rooms must
// not stay waiting for the check of a write that never happened.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomRf.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){return {user:globalThis.roomRf.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:true}}",
};
const fixture = await loadFixture({ name: "room-rf", entryPoint: "src/app/api/calendar/events/[eventId]/route.ts", mocks });
const { PATCH } = await fixture.import();
let sqlite;
let armed = false;
after(() => { sqlite?.close(); delete globalThis.roomRf; fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const H = 3_600_000;
function setup() {
	sqlite?.close();
	armed = false;
	sqlite = installSqlite("roomRf", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true } }, beforeQuery: (sql) => { if (armed && /^update "calendar_events"/i.test(sql)) throw new Error("UNIQUE constraint failed: calendar_events.id"); } });
	globalThis.roomRf.db.batchIsAtomic = false;
	// Statements run one by one, as on Neon over HTTP: the decline that came first stays when a later one is refused. Only the first batch is refused.
	let refused = false;
	globalThis.roomRf.db.batch = async (list) => { armed = !refused; try { for (const statement of list) await statement; } finally { armed = false; refused = true; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, time_zone, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 'UTC', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, time_zone, created_at, updated_at) VALUES ('e1', 'u1', 'Standup', ?, ?, 'UTC', 1, 1)").run(Math.floor((FUTURE + 9 * H) / 1000), Math.floor((FUTURE + 10 * H) / 1000));
	sqlite.exec("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', 'e1', 'accepted', 1)");
}
const row = () => sqlite.prepare("SELECT status, conflict_at FROM calendar_resource_bookings WHERE event_id = 'e1'").get();

test("a refused save (409) re-checks the event's rooms, so they do not stay waiting", async () => {
	setup();
	const response = await PATCH(new Request("https://m.test/api/calendar/events/e1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Standup", startsAt: new Date(FUTURE + 13 * H).toISOString(), endsAt: new Date(FUTURE + 14 * H).toISOString() }) }), { params: Promise.resolve({ eventId: "e1" }) });
	assert.equal(response.status, 409);
	assert.equal(sqlite.prepare("SELECT starts_at FROM calendar_events WHERE id = 'e1'").get().starts_at, Math.floor((FUTURE + 9 * H) / 1000), "the write never happened");
	assert.deepEqual({ ...row() }, { status: "accepted", conflict_at: null }, "checked again at the time it still has");
});

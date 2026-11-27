import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// M-7: a room's schedule is read in start order, and says so when it hit its cap.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomCap.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){return {user:globalThis.roomCap.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:true}}",
};
const fixture = await loadFixture({ name: "room-cap", entryPoint: "src/app/api/calendar/events/route.ts", mocks });
const { GET } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomCap; fixture.dispose(); });

const T0 = Date.UTC(2030, 0, 7);
function setup(count) {
	sqlite?.close();
	sqlite = installSqlite("roomCap", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true } } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${count - 1}) INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) SELECT 'e' || printf('%05d', 9999 - i), 'u1', 't', ${Math.floor(T0 / 1000)} + (9999 - i) * 60, ${Math.floor(T0 / 1000)} + (9999 - i) * 60 + 30, 1, 1 FROM n`);
	sqlite.exec("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) SELECT 'b' || id, 'r1', id, 'accepted', 1 FROM calendar_events");
}
const get = async () => (await GET(new Request(`https://m.test/api/calendar/events?start=${new Date(T0).toISOString()}&end=${new Date(T0 + 30 * 86_400_000).toISOString()}&resourceIds=r1`))).json();

test("at the cap the earliest bookings are returned, in start order, with a flag that says more exist", async () => {
	setup(2001);
	const body = await get();
	assert.equal(body.roomEvents.length, 2000);
	assert.equal(body.roomEventsTruncated, true);
	const starts = body.roomEvents.map((event) => Date.parse(event.startsAt));
	assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "sorted by start");
	assert.equal(starts[0], T0 + 7999 * 60_000, "the earliest of the 2001 is first");
	assert.ok(!body.roomEvents.some((event) => Date.parse(event.startsAt) > starts[1999]), "nothing later than the last returned start is mixed in");
});

test("under the cap there is no flag", async () => {
	setup(2000);
	const body = await get();
	assert.equal(body.roomEvents.length, 2000);
	assert.equal("roomEventsTruncated" in body, false);
});

test("the editor shows a note when a room's schedule is cut short", () => {
	const page = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");
	assert.match(page, /roomEventsTruncated/);
	assert.match(page, /t\("calendar\.rooms\.truncated"\)/);
	const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
	assert.match(en["calendar.rooms.truncated"], /not all|not every|some/i);
});

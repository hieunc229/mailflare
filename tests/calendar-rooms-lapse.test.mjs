import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// M-5: after a licence lapses only ACCEPTED bookings count as kept; a declined room never flips to accepted.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomLp.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){return {user:globalThis.roomLp.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomLp.team}}",
};
const route = await loadFixture({ name: "room-lp-route", entryPoint: "src/app/api/calendar/events/[eventId]/route.ts", mocks });
const lib = await loadFixture({ name: "room-lp-lib", entryPoint: "src/lib/calendar/resources.ts", mocks: {} });
const { PATCH } = await route.import();
const { resolveBookableRooms } = await lib.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomLp; route.dispose(); lib.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const H = 3_600_000;
const iso = (hours) => new Date(FUTURE + hours * H).toISOString();
function setup() {
	sqlite?.close();
	sqlite = installSqlite("roomLp", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, team: true } });
	globalThis.roomLp.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	for (const id of ["r1", "r2"]) sqlite.exec(`INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('${id}', 'Room ${id}', 1, 1)`);
	const add = (id, hour) => sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, time_zone, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?, 'UTC', 1, 1)").run(id, Math.floor((FUTURE + hour * H) / 1000), Math.floor((FUTURE + (hour + 1) * H) / 1000));
	add("mine", 9);
	// r1 is declined for "mine" (it was taken when booked) and is free now; r2 is accepted.
	sqlite.exec("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', 'mine', 'declined', 1), ('b2', 'r2', 'mine', 'accepted', 1)");
}
const statuses = () => sqlite.prepare("SELECT resource_id, status FROM calendar_resource_bookings WHERE event_id = 'mine' ORDER BY resource_id").all().map((row) => [row.resource_id, row.status]);
const patch = (extra = {}) => PATCH(new Request("https://m.test/api/calendar/events/mine", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Edited", startsAt: iso(9), endsAt: iso(10), ...extra }) }), { params: Promise.resolve({ eventId: "mine" }) });

test("lib: with the licence lapsed only the rooms that are accepted count as kept", async () => {
	setup();
	const db = globalThis.roomLp.db;
	assert.equal((await resolveBookableRooms(db, ["r1", "r2"], { booked: ["r2"], canBook: false })).code, "TEAM_REQUIRED", "r1 is declined, so naming it again is a new booking");
	assert.equal((await resolveBookableRooms(db, ["r2"], { booked: ["r2"], canBook: false })).ok, true);
	assert.equal((await resolveBookableRooms(db, ["r1", "r2"], { booked: ["r1", "r2"], canBook: true })).ok, true, "with a licence nothing changes");
});

test("a lapsed licence: saving the event keeps the accepted room accepted and the declined one declined, even though it is free now", async () => {
	setup();
	globalThis.roomLp.team = false;
	assert.equal((await patch({ title: "Moved", startsAt: iso(13), endsAt: iso(14) })).status, 200);
	assert.deepEqual(statuses(), [["r1", "declined"], ["r2", "accepted"]]);
});

test("a lapsed licence: asking for the declined room again is refused, and nothing changes", async () => {
	setup();
	globalThis.roomLp.team = false;
	const refused = await patch({ resourceIds: ["r1", "r2"] });
	assert.deepEqual([refused.status, (await refused.json()).code], [403, "TEAM_REQUIRED"]);
	assert.deepEqual(statuses(), [["r1", "declined"], ["r2", "accepted"]]);
	assert.equal((await patch({ resourceIds: ["r2"] })).status, 200, "dropping the declined room is always possible");
	assert.deepEqual(statuses(), [["r2", "accepted"]]);
});

test("with a licence the same save re-checks both rooms, so the declined one is accepted now that it is free", async () => {
	setup();
	assert.equal((await patch({ title: "Edited" })).status, 200);
	assert.deepEqual(statuses(), [["r1", "accepted"], ["r2", "accepted"]]);
});

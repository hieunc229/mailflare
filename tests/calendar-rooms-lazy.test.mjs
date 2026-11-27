import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// Bookings left waiting for their check (declined, marked with the epoch) are re-checked a few at a time when their owner loads the calendar.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomLz.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){return {user:globalThis.roomLz.user,key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(){}",
	"@/lib/email/send": "export async function sendEmail(){}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomLz.team}}",
};
const fixture = await loadFixture({ name: "room-lz", entryPoint: "src/app/api/calendar/events/route.ts", mocks });
const { GET } = await fixture.import();
let sqlite;
let statements = [];
after(() => { sqlite?.close(); delete globalThis.roomLz; fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const H = 3_600_000;
const secs = (ms) => Math.floor(ms / 1000);
function setup({ team = true } = {}) {
	sqlite?.close();
	statements = [];
	sqlite = installSqlite("roomLz", { schema, extra: { user: { id: "u1", timeZone: "UTC", calendarEnabled: true }, team }, beforeQuery: (sql) => { statements.push(sql); } });
	globalThis.roomLz.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
}
function waiting(id, { user = "u1", hour, status = "declined", conflictAt = 0 } = {}) {
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, time_zone, created_at, updated_at) VALUES (?, ?, 't', ?, ?, 'UTC', 1, 1)").run(id, user, secs(FUTURE + hour * H), secs(FUTURE + (hour + 0.5) * H));
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, conflict_at, created_at) VALUES (?, 'r1', ?, ?, ?, 1)").run(`b_${id}`, id, status, conflictAt);
}
const status = (id) => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").get(id).status;
const get = async () => (await GET(new Request(`https://m.test/api/calendar/events?start=${new Date(FUTURE).toISOString()}&end=${new Date(FUTURE + 86_400_000).toISOString()}`))).json();

test("loading the calendar re-checks up to 5 waiting bookings of the caller and says how many still wait", async () => {
	setup();
	for (let index = 0; index < 8; index += 1) waiting(`w${index}`, { hour: 1 + index });
	waiting("theirs", { user: "u2", hour: 20 });
	waiting("real", { hour: 22, conflictAt: secs(FUTURE + 22 * H) });
	const first = await get();
	assert.equal(Array.from({ length: 8 }, (_, index) => status(`w${index}`)).filter((value) => value === "accepted").length, 5);
	assert.equal(first.roomsPending, 3);
	assert.equal(status("theirs"), "declined", "another account's waiting booking is not this request's business");
	assert.equal(status("real"), "declined", "a booking that really clashed is not a waiting one");
	const second = await get();
	assert.equal(Array.from({ length: 8 }, (_, index) => status(`w${index}`)).filter((value) => value === "accepted").length, 8);
	assert.equal("roomsPending" in second, false);
});

test("with nothing waiting it costs one query, and it says nothing", async () => {
	setup();
	waiting("real", { hour: 22 + 72, conflictAt: secs(FUTURE + 94 * H) });
	statements = [];
	const body = await get();
	assert.equal("roomsPending" in body, false);
	assert.equal(statements.filter((sql) => /calendar_resource_bookings/.test(sql)).length, 1, "one probe of the bookings, nothing else");
});

test("it never fails the request: a check that breaks is logged, the booking stays declined, and the calendar still loads", async () => {
	setup();
	waiting("w1", { hour: 1 });
	const real = globalThis.roomLz.db.batch;
	globalThis.roomLz.db.batch = async () => { throw new Error("database busy"); };
	const errors = [];
	const log = console.error;
	console.error = (...args) => { errors.push(args.map(String).join(" ")); };
	let response;
	try { response = await GET(new Request(`https://m.test/api/calendar/events?start=${new Date(FUTURE).toISOString()}&end=${new Date(FUTURE + 86_400_000).toISOString()}`)); } finally { console.error = log; globalThis.roomLz.db.batch = real; }
	assert.equal(response.status, 200);
	assert.equal((await response.json()).events.length, 1, "the event is still listed");
	assert.equal(status("w1"), "declined");
	assert.ok(errors.length >= 1, "logged");
});

test("a lapsed licence still re-checks a booking that was only waiting (it was accepted before)", async () => {
	setup({ team: false });
	waiting("w1", { hour: 1 });
	await get();
	assert.equal(status("w1"), "accepted");
});

test("the calendar page shows a small note while bookings still wait, in every language", () => {
	const page = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");
	assert.match(page, /roomsPending\?: number/);
	assert.match(page, /setRoomsPending\(data\.roomsPending \?\? 0\)/);
	assert.match(page, /roomsPending > 0 && <p role="status"[^>]*>\{t\("calendar\.rooms\.pending", \{ count: roomsPending \}\)\}/);
	const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
	assert.match(en["calendar.rooms.pending"], /\{count\}/);
});

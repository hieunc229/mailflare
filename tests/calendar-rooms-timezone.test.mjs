import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// Changing the account's time zone moves the events that are read in the account's zone, so the rooms of those events are checked again.
// A repeating event with no zone is frozen to the request's zone first, so it moves only when the account had no zone before; an all-day
// event with no zone always moves.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomTz.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.roomTz.user}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){globalThis.roomTz.licenceChecks += 1; return {canShareMailboxes:globalThis.roomTz.team}}",
};
const fixture = await loadFixture({ name: "room-tz", entryPoint: "src/app/api/settings/time-zone/route.ts", mocks });
const { PATCH } = await fixture.import();
let sqlite;
let dead = false;
let batches = 0;
after(() => { sqlite?.close(); delete globalThis.roomTz; fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const H = 3_600_000;
const secs = (ms) => Math.floor(ms / 1000);
function setup({ accountZone = "UTC", team = true } = {}) {
	sqlite?.close();
	dead = false;
	batches = 0;
	sqlite = installSqlite("roomTz", { schema, extra: { user: { id: "u1", timeZone: accountZone }, team, licenceChecks: 0 }, beforeQuery: () => { if (dead) throw new Error("process died"); } });
	globalThis.roomTz.db.batch = async (list) => { batches += 1; sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } dead = globalThis.roomTz.dieAfterBatch === true; };
	sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, time_zone, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', ?, 1)").run(accountZone);
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, time_zone, created_at) VALUES ('u2', 'u2@one.test', 'Other', 'x', 'user', NULL, 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
}
let counter = 0;
function add({ id = `e${++counter}`, user = "u1", zone = null, repeat = "none", allDay = 0, hour = 9, status = "accepted" } = {}) {
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, time_zone, all_day, created_at, updated_at) VALUES (?, ?, 't', ?, ?, ?, ?, ?, 1, 1)").run(id, user, secs(FUTURE + hour * H), secs(FUTURE + (hour + 0.5) * H), repeat, zone, allDay);
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, 'r1', ?, ?, 1)").run(`b_${id}`, id, status);
	return id;
}
const status = (id) => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").get(id).status;
const change = (zone) => PATCH(new Request("https://m.test/api/settings/time-zone", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeZone: zone }) }));

test("a zone change that dies before the room step leaves the bookings of the events that move declined, and touches no other", async () => {
	setup();
	const allDay = add({ allDay: 1, hour: 1 });
	const repeating = add({ repeat: "weekly", hour: 3 });
	const zoned = add({ zone: "Europe/Berlin", repeat: "weekly", hour: 5 });
	const plain = add({ hour: 7 });
	const someoneElses = add({ user: "u2", allDay: 1, hour: 11 });
	globalThis.roomTz.dieAfterBatch = true;
	await change("Asia/Tokyo").catch(() => {});
	assert.equal(sqlite.prepare("SELECT time_zone FROM users WHERE id = 'u1'").get().time_zone, "Asia/Tokyo");
	assert.equal(status(allDay), "declined", "an all-day event with no zone is read in the account's zone, so it moves");
	assert.equal(status(repeating), "accepted", "a repeating event is frozen to the zone it had, so it does not move");
	assert.equal(status(zoned), "accepted", "an event with its own zone does not move");
	assert.equal(status(plain), "accepted", "a one-off timed event does not move");
	assert.equal(status(someoneElses), "accepted", "another account's event is none of this request's business");
});

test("an account that had no zone before: its repeating events with no zone move too", async () => {
	setup({ accountZone: null });
	const repeating = add({ repeat: "weekly" });
	globalThis.roomTz.dieAfterBatch = true;
	await change("Asia/Tokyo").catch(() => {});
	assert.equal(status(repeating), "declined");
});

test("the room step then books the moved events again when they are free", async () => {
	setup();
	const allDay = add({ allDay: 1, hour: 1 });
	assert.equal((await change("Asia/Tokyo")).status, 200);
	assert.equal(status(allDay), "accepted");
});

test("one UPDATE declines them all, however many there are, and only about 20 are re-checked in the request: the rest wait declined, which fails closed", async () => {
	setup();
	// 45 events with no zone, an hour apart, so none clashes with another.
	const ids = Array.from({ length: 45 }, (_, index) => add({ allDay: 1, hour: 1 + index, id: `x${index}` }));
	assert.equal((await change("Asia/Tokyo")).status, 200);
	const now = ids.map(status);
	assert.equal(now.filter((value) => value === "accepted").length, 20, "re-checked");
	assert.equal(now.filter((value) => value === "declined").length, 25, "left pending");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_resource_bookings WHERE status = 'declined' AND conflict_at = 0").get().n, 25, "pending, marked as waiting for their check");
});

test("a request that does not change the zone does nothing at all", async () => {
	setup({ accountZone: "Asia/Tokyo" });
	const repeating = add({ repeat: "weekly" });
	const allDay = add({ allDay: 1, hour: 1 });
	assert.equal((await change("Asia/Tokyo")).status, 200);
	assert.equal(batches, 0);
	assert.equal(sqlite.prepare("SELECT time_zone FROM calendar_events WHERE id = ?").get(repeating).time_zone, null, "nothing was frozen");
	assert.deepEqual([status(repeating), status(allDay)], ["accepted", "accepted"]);
});

test("the licence is asked once per request, however many events have a declined room", async () => {
	setup({ team: true });
	for (let index = 0; index < 5; index += 1) { const id = add({ allDay: 1, hour: 1 + index }); sqlite.prepare("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)").run(`x${index}`, `X${index}`); sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, ?, ?, 'declined', 1)").run(`bd${index}`, `x${index}`, id); }
	assert.equal((await change("Asia/Tokyo")).status, 200);
	assert.ok(globalThis.roomTz.licenceChecks <= 1, `${globalThis.roomTz.licenceChecks} checks`);
});

test("a user with no rooms changes zone as before", async () => {
	setup();
	assert.equal((await change("Asia/Tokyo")).status, 200);
	assert.equal(sqlite.prepare("SELECT time_zone FROM users WHERE id = 'u1'").get().time_zone, "Asia/Tokyo");
});

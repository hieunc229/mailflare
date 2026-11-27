import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// m-5: transferring an account moves its events to another owner; events read in their owner's zone (an all-day event, or a repeating one, with
// no zone of its own) move with it, so the rooms of those are declined in the same batch and checked again, as for a time-zone change.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const stub = (names) => names.map((name) => `export const ${name} = () => { throw new Error("${name} is not used by a transfer") };`).join("\n");
const fixture = await loadFixture({
	name: "room-transfer",
	entryPoint: "src/lib/accounts/deletion.ts",
	mocks: {
		"@/db": "export function getDb(){return globalThis.roomTr.db}",
		"@/lib/auth/admin": stub(["canManageUsers", "isPrimaryAdmin"]),
		"@/lib/drive/access": stub(["deleteDriveItems"]),
		"@/lib/licenses/seats": stub(["getAccountSeatError"]),
		"@/lib/mailboxes/domain-addresses": stub(["removeMailboxDomainRouting"]),
		"@/app/api/profile/avatar/utils": stub(["avatarKeyFor"]),
		"@/lib/drive/shared-objects": stub(["deleteUnreferencedObjects"]),
		"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomTr.team}}",
	},
});
const { transferAccountData } = await fixture.import();
let sqlite;
let dead = false;
let batches = 0;
after(() => { sqlite?.close(); delete globalThis.roomTr; fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const H = 3_600_000;
const secs = (ms) => Math.floor(ms / 1000);
function setup({ team = true } = {}) {
	sqlite?.close();
	dead = false;
	batches = 0;
	sqlite = installSqlite("roomTr", { schema, extra: { team, dieAfterBatch: false }, beforeQuery: () => { if (dead) throw new Error("process died"); } });
	globalThis.roomTr.db.batch = async (list) => { batches += 1; sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } dead = globalThis.roomTr.dieAfterBatch; };
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
}
function add(id, { zone = null, repeat = "none", allDay = 0, hour = 9, status = "accepted" } = {}) {
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, time_zone, all_day, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?, ?, ?, ?, 1, 1)").run(id, secs(FUTURE + hour * H), secs(FUTURE + (hour + 0.5) * H), repeat, zone, allDay);
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, 'r1', ?, ?, 1)").run(`b_${id}`, id, status);
}
const status = (id) => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").get(id).status;

test("a transfer that dies before the room step leaves the bookings of the events that move declined, and touches no other", async () => {
	setup();
	add("allday", { allDay: 1, hour: 1 }); add("repeating", { repeat: "weekly", hour: 3 }); add("zoned", { zone: "Europe/Berlin", repeat: "weekly", hour: 5 }); add("plain", { hour: 7 });
	globalThis.roomTr.dieAfterBatch = true;
	await transferAccountData({}, "u1", "A", "u2").catch(() => {});
	assert.equal(sqlite.prepare("SELECT user_id FROM calendar_events WHERE id = 'allday'").get().user_id, "u2", "the event moved");
	assert.deepEqual(["allday", "repeating", "zoned", "plain"].map(status), ["declined", "declined", "accepted", "accepted"]);
});

test("the room step books the moved events again when they are free, at most about 20 in the request", async () => {
	setup();
	for (let index = 0; index < 30; index += 1) add(`x${index}`, { allDay: 1, hour: 1 + index * 0.5 });
	await transferAccountData({}, "u1", "A", "u2");
	const now = Array.from({ length: 30 }, (_, index) => status(`x${index}`));
	assert.equal(now.filter((value) => value === "accepted").length, 20);
	assert.equal(now.filter((value) => value === "declined").length, 10, "the rest wait for their check");
});

test("with the licence lapsed a room that was declined stays declined, and the accepted one is checked again", async () => {
	setup({ team: false });
	add("a", { allDay: 1, hour: 1, status: "declined" });
	add("b", { allDay: 1, hour: 3 });
	await transferAccountData({}, "u1", "A", "u2");
	assert.deepEqual([status("a"), status("b")], ["declined", "accepted"]);
});

test("the transfer always runs the decline and the move as one batch, with no read of the bookings first (a booking made at any moment is covered)", async () => {
	setup();
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'u1', 't', 1, 2, 1, 1)").run();
	const statements = [];
	const real = globalThis.roomTr.db.batch;
	globalThis.roomTr.db.batch = async (list) => { statements.push(list.length); return real(list); };
	await transferAccountData({}, "u1", "A", "u2");
	assert.deepEqual(statements, [2], "one batch of the decline and the move, even for an account with no rooms");
	assert.equal(sqlite.prepare("SELECT user_id FROM calendar_events WHERE id = 'e1'").get().user_id, "u2");
});

test("a database handle with no batch (a test shim) still declines first and moves second, in that order", async () => {
	setup();
	add("allday", { allDay: 1, hour: 1 });
	delete globalThis.roomTr.db.batch;
	globalThis.roomTr.dieAfterBatch = false;
	// A log of which table each write touches first: the bookings, then the events.
	sqlite.exec("CREATE TABLE write_log (n INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT)");
	sqlite.exec("CREATE TRIGGER log_bookings AFTER UPDATE ON calendar_resource_bookings BEGIN INSERT INTO write_log (what) VALUES ('bookings'); END");
	sqlite.exec("CREATE TRIGGER log_events AFTER UPDATE OF user_id ON calendar_events BEGIN INSERT INTO write_log (what) VALUES ('events'); END");
	await transferAccountData({}, "u1", "A", "u2");
	assert.equal(sqlite.prepare("SELECT user_id FROM calendar_events WHERE id = 'allday'").get().user_id, "u2");
	assert.deepEqual(sqlite.prepare("SELECT what FROM write_log ORDER BY n").all().map((row) => row.what).slice(0, 2), ["bookings", "events"], "the decline came first");
	assert.equal(status("allday"), "declined", "the room step needs a batch too, so with none it fails closed rather than accepting");
});

test("a transfer of an account with no rooms moves its events as before", async () => {
	setup();
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'u1', 't', 1, 2, 1, 1)").run();
	await transferAccountData({}, "u1", "A", "u2");
	assert.equal(sqlite.prepare("SELECT user_id FROM calendar_events WHERE id = 'e1'").get().user_id, "u2");
});

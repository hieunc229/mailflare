import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "cal-rooms-rebook", entryPoint: "src/lib/calendar/room-save.ts", mocks: {} });
const { rebookEvents } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.rebook; fixture.dispose(); });

const H = 3_600_000;
const T0 = Date.now() + 30 * 86_400_000;
const secs = (ms) => Math.floor(ms / 1000);
function setup() {
	sqlite?.close();
	sqlite = installSqlite("rebook", { schema });
	globalThis.rebook.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	return globalThis.rebook.db;
}
const event = (id, from, to) => sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?, 1, 1)").run(id, secs(T0 + from * H), secs(T0 + to * H));
const book = (id, status) => sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, 'r1', ?, ?, 1)").run(`b_${id}`, id, status);
const status = (id) => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").get(id)?.status;

test("an event changed outside the web editor is checked again: moved onto another booking it is declined, and an event with no rooms is left alone", async () => {
	const db = setup();
	event("a", 1, 2); book("a", "accepted");
	event("b", 5, 6); book("b", "accepted");
	event("plain", 1, 2);
	sqlite.prepare("UPDATE calendar_events SET starts_at = ?, ends_at = ? WHERE id = 'b'").run(secs(T0 + 1.5 * H), secs(T0 + 2.5 * H));
	await rebookEvents(db, ["b", "plain"], async () => true);
	assert.deepEqual([status("a"), status("b"), status("plain")], ["accepted", "declined", undefined]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_resource_bookings").get().n, 2);
});

test("a failure to check never throws to the caller that already saved the event", async () => {
	const db = setup();
	event("a", 1, 2); book("a", "accepted");
	db.batch = async () => { throw new Error("database busy"); };
	await assert.doesNotReject(() => rebookEvents(db, ["a"], async () => true));
});

test("the CalDAV write and the MCP update tool re-check rooms after saving", () => {
	const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
	assert.match(read("src/lib/dav/calendar-write.ts"), /rebookEvents\(db, \[id\], roomsBookable\(ctx\.env\)\)/);
	assert.match(read("src/lib/calendar/tools.ts"), /rebookEvents\(db, ids, roomsBookable\(context\.env\)\)/);
});

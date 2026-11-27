import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// M-2: changing the account's time zone moves zoneless repeating and all-day events, so the rooms of those events are checked again.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomTz.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.roomTz.user}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
};
const fixture = await loadFixture({ name: "room-tz", entryPoint: "src/app/api/settings/time-zone/route.ts", mocks });
const { PATCH } = await fixture.import();
let sqlite;
let dead = false;
after(() => { sqlite?.close(); delete globalThis.roomTz; fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const secs = (ms) => Math.floor(ms / 1000);
function setup() {
	sqlite?.close();
	dead = false;
	sqlite = installSqlite("roomTz", { schema, extra: { user: { id: "u1", timeZone: "UTC" } }, beforeQuery: () => { if (dead) throw new Error("process died"); } });
	globalThis.roomTz.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } dead = globalThis.roomTz.dieAfterBatch === true; };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, time_zone, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 'UTC', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	const add = (id, zone, repeat, hour) => {
		sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, time_zone, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?, ?, ?, 1, 1)").run(id, secs(FUTURE + hour * 3_600_000), secs(FUTURE + (hour + 1) * 3_600_000), repeat, zone);
		sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, 'r1', ?, 'accepted', 1)").run(`b_${id}`, id);
	};
	add("zoneless", null, "weekly", 9);
	add("zoned", "Europe/Berlin", "weekly", 12);
	add("plain", null, "none", 15);
}
const status = (id) => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").get(id).status;
const change = (zone) => PATCH(new Request("https://m.test/api/settings/time-zone", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeZone: zone }) }));

test("a zone change that dies before the room step leaves the zoneless repeating event's booking declined, and touches no other", async () => {
	setup();
	globalThis.roomTz.dieAfterBatch = true;
	await change("Asia/Tokyo").catch(() => {});
	assert.equal(sqlite.prepare("SELECT time_zone FROM users WHERE id = 'u1'").get().time_zone, "Asia/Tokyo");
	assert.equal(status("zoneless"), "declined");
	assert.equal(status("zoned"), "accepted", "an event with its own zone does not move");
	assert.equal(status("plain"), "accepted", "a one-off timed event does not move");
});

test("the room step then books the moved series again when it is free", async () => {
	setup();
	const response = await change("Asia/Tokyo");
	assert.equal(response.status, 200);
	assert.equal(status("zoneless"), "accepted");
	assert.equal(status("zoned"), "accepted");
});

test("a user with no rooms changes zone as before", async () => {
	setup();
	sqlite.exec("DELETE FROM calendar_resource_bookings");
	assert.equal((await change("Asia/Tokyo")).status, 200);
	assert.equal(sqlite.prepare("SELECT time_zone FROM users WHERE id = 'u1'").get().time_zone, "Asia/Tokyo");
});

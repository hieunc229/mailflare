import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const service = await loadFixture({ name: "cal-fb-allday2", entryPoint: "src/lib/calendar/free-busy.ts", mocks: { "@/db": "export function getDb(){return globalThis.calFbDay2.db}" } });
const { busyIntervals } = await service.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calFbDay2; service.dispose(); });

const H = 3_600_000;
const secs = (ms) => Math.floor(ms / 1000);
function setup(userZone = "UTC") {
	sqlite?.close();
	sqlite = installSqlite("calFbDay2", { schema });
	sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at, time_zone) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1, '${userZone}')`);
}
// An all-day event is stored as the instants of its midnights in its zone (calendar-parse, invite): the row is not floating.
function allDay(id, startMs, endMs, { zone, repeat = "none", until = null } = {}) {
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, all_day, time_zone, repeat${until ? ", repeat_until" : ""}) VALUES ('${id}', 'u1', 'Away', ${secs(startMs)}, ${secs(endMs)}, 1, 1, 1, ${zone ? `'${zone}'` : "NULL"}, '${repeat}'${until ? `, ${secs(until)}` : ""})`);
}
const busy = async (from, to) => (await busyIntervals({}, { userIds: ["u1"] }, new Date(from), new Date(to))).get("u1");


test("a daily all-day series in London: the 25-hour day of the clocks going back is still busy when asked from 23:30Z, an hour before it ends", async () => {
	setup();
	const start = Date.UTC(2026, 9, 20, 23); // 00:00 BST on 21 Oct; the clocks go back on 25 Oct, a 25-hour day ending 2026-10-26T00:00Z
	allDay("a", start, start + 24 * H, { zone: "Europe/London", repeat: "daily" });
	const from = Date.UTC(2026, 9, 25, 23, 30);
	const to = Date.UTC(2026, 9, 26, 12);
	const result = await busy(from, to);
	assert.deepEqual(result, [[from, to]], JSON.stringify(result.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()])));
});

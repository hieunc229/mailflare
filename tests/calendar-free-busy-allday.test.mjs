import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const service = await loadFixture({ name: "cal-fb-allday", entryPoint: "src/lib/calendar/free-busy.ts", mocks: { "@/db": "export function getDb(){return globalThis.calFbDay.db}" } });
const { busyIntervals } = await service.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calFbDay; service.dispose(); });

const H = 3_600_000;
const secs = (ms) => Math.floor(ms / 1000);
function setup(userZone = "UTC") {
	sqlite?.close();
	sqlite = installSqlite("calFbDay", { schema });
	sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at, time_zone) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1, '${userZone}')`);
}
// An all-day event is stored as the instants of its midnights in its zone (calendar-parse, invite): the row is not floating.
function allDay(id, startMs, endMs, { zone, repeat = "none", until = null } = {}) {
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, all_day, time_zone, repeat${until ? ", repeat_until" : ""}) VALUES ('${id}', 'u1', 'Away', ${secs(startMs)}, ${secs(endMs)}, 1, 1, 1, ${zone ? `'${zone}'` : "NULL"}, '${repeat}'${until ? `, ${secs(until)}` : ""})`);
}
const busy = async (from, to) => (await busyIntervals({}, { userIds: ["u1"] }, new Date(from), new Date(to))).get("u1");

test("a single all-day event is busy from its first midnight to its second, whoever asks and wherever they are", async () => {
	setup();
	const start = Date.UTC(2030, 0, 9, 18, 30); // 00:00 on 10 Jan in Asia/Kolkata
	allDay("a", start, start + 24 * H, { zone: "Asia/Kolkata" });
	assert.deepEqual(await busy(Date.UTC(2030, 0, 1), Date.UTC(2030, 1, 1)), [[start, start + 24 * H]]);
});

test("a daily all-day series across the autumn clock change stays busy through the 25-hour day (no free hour before the next midnight)", async () => {
	setup();
	const start = Date.UTC(2030, 10, 1, 4); // 00:00 EDT on 1 Nov, America/New_York; the clocks go back on 3 Nov
	allDay("a", start, start + 24 * H, { zone: "America/New_York", repeat: "daily", until: Date.UTC(2030, 10, 8, 5) });
	const result = await busy(Date.UTC(2030, 10, 1), Date.UTC(2030, 10, 9));
	assert.deepEqual(result, [[start, Date.UTC(2030, 10, 8, 5)]], `one block, got ${JSON.stringify(result.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]))}`);
});

test("a daily all-day series across the spring clock change ends each day at its own midnight", async () => {
	setup();
	const start = Date.UTC(2030, 2, 8, 5); // 00:00 EST on 8 Mar; the clocks go forward on 10 Mar
	allDay("a", start, start + 24 * H, { zone: "America/New_York", repeat: "weekly" });
	const result = await busy(Date.UTC(2030, 2, 1), Date.UTC(2030, 2, 30));
	// Weekly from Fri 8 Mar: the 15th is after the change, midnight EDT is 04:00Z, so the day ends 04:00Z on the 16th.
	assert.deepEqual(result.map(([from, to]) => [new Date(from).toISOString(), new Date(to).toISOString()]).slice(0, 2), [["2030-03-08T05:00:00.000Z", "2030-03-09T05:00:00.000Z"], ["2030-03-15T04:00:00.000Z", "2030-03-16T04:00:00.000Z"]]);
});

test("an all-day series with no zone of its own (a floating invitation) keeps midnight in the owner's zone across a clock change", async () => {
	setup("America/New_York");
	const start = Date.UTC(2030, 10, 1, 4);
	allDay("a", start, start + 24 * H, { zone: null, repeat: "daily", until: Date.UTC(2030, 10, 8, 5) });
	assert.deepEqual(await busy(Date.UTC(2030, 10, 1), Date.UTC(2030, 10, 9)), [[start, Date.UTC(2030, 10, 8, 5)]]);
});

test("a timed event keeps its length across a clock change (only all-day events are measured in days)", async () => {
	setup();
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone, repeat) VALUES ('t', 'u1', 'T', ${secs(Date.UTC(2030, 10, 1, 13))}, ${secs(Date.UTC(2030, 10, 1, 14))}, 1, 1, 'America/New_York', 'daily')`);
	const result = await busy(Date.UTC(2030, 10, 2), Date.UTC(2030, 10, 5));
	assert.ok(result.every(([from, to]) => to - from === H));
});

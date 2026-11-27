import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const service = await loadFixture({ name: "cal-fb-timed", entryPoint: "src/lib/calendar/free-busy.ts", mocks: { "@/db": "export function getDb(){return globalThis.calFbTimed.db}" } });
const { busyIntervals } = await service.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calFbTimed; service.dispose(); });

const H = 3_600_000;
const secs = (ms) => Math.floor(ms / 1000);
function setup(userZone = "UTC") {
	sqlite?.close();
	sqlite = installSqlite("calFbTimed", { schema });
	sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at, time_zone) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1, '${userZone}')`);
}
function timed(id, startMs, { zone, repeat, extra = "" }) {
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, time_zone, repeat${extra ? ", rrule" : ""}) VALUES ('${id}', 'u1', 'T', ${secs(startMs)}, ${secs(startMs + H)}, 1, 1, ${zone ? `'${zone}'` : "NULL"}, '${repeat}'${extra ? `, '${extra}'` : ""})`);
}
const busy = async (from, to) => (await busyIntervals({}, { userIds: ["u1"] }, new Date(from), new Date(to))).get("u1").map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]);

test("a timed daily row with no zone keeps its wall-clock time in the owner's zone across a clock change, as the calendar view shows it", async () => {
	setup("America/New_York");
	timed("a", Date.UTC(2030, 10, 1, 13), { zone: null, repeat: "daily" }); // 09:00 EDT; the clocks go back on 3 Nov
	assert.deepEqual(await busy(Date.UTC(2030, 10, 2), Date.UTC(2030, 10, 6)), [
		["2030-11-02T13:00:00.000Z", "2030-11-02T14:00:00.000Z"],
		["2030-11-03T14:00:00.000Z", "2030-11-03T15:00:00.000Z"],
		["2030-11-04T14:00:00.000Z", "2030-11-04T15:00:00.000Z"],
		["2030-11-05T14:00:00.000Z", "2030-11-05T15:00:00.000Z"],
	]);
});

test("the same for a custom rule, and a bad stored zone counts as missing", async () => {
	setup("America/New_York");
	timed("a", Date.UTC(2030, 10, 1, 13), { zone: null, repeat: "custom", extra: "FREQ=DAILY" });
	timed("b", Date.UTC(2030, 10, 1, 15), { zone: "Not/AZone", repeat: "daily" });
	const result = await busy(Date.UTC(2030, 10, 4), Date.UTC(2030, 10, 5));
	assert.deepEqual(result, [["2030-11-04T14:00:00.000Z", "2030-11-04T15:00:00.000Z"], ["2030-11-04T16:00:00.000Z", "2030-11-04T17:00:00.000Z"]]);
});

test("a row with its own zone, and a row that does not repeat, are not touched by the owner's zone", async () => {
	setup("America/New_York");
	timed("a", Date.UTC(2030, 10, 1, 13), { zone: "Asia/Kolkata", repeat: "daily" });
	timed("b", Date.UTC(2030, 10, 4, 20), { zone: null, repeat: "none" });
	assert.deepEqual(await busy(Date.UTC(2030, 10, 4), Date.UTC(2030, 10, 5)), [["2030-11-04T13:00:00.000Z", "2030-11-04T14:00:00.000Z"], ["2030-11-04T20:00:00.000Z", "2030-11-04T21:00:00.000Z"]]);
});

test("an owner whose zone is UTC (the default) sees what it always did", async () => {
	setup();
	timed("a", Date.UTC(2030, 10, 1, 13), { zone: null, repeat: "daily" });
	assert.deepEqual(await busy(Date.UTC(2030, 10, 4), Date.UTC(2030, 10, 5)), [["2030-11-04T13:00:00.000Z", "2030-11-04T14:00:00.000Z"]]);
});

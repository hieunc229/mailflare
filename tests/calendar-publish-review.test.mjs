import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "cal-pub-review", entryPoint: "src/lib/calendar/free-busy-publish.ts", mocks: { "@/db": "export function getDb(){return globalThis.calPubRev.db}" } });
const { publishWindow, publishedBusy, buildFreeBusyIcs } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calPubRev; fixture.dispose(); });

const DAY = 86_400_000;

test("the window starts and ends at UTC midnight and does not move during the day", () => {
	const morning = publishWindow(new Date(Date.UTC(2030, 0, 15, 1, 23, 17, 456)));
	const night = publishWindow(new Date(Date.UTC(2030, 0, 15, 23, 59, 59, 999)));
	assert.equal(morning.start.toISOString(), "2030-01-08T00:00:00.000Z");
	assert.equal(morning.end.toISOString(), "2030-03-12T00:00:00.000Z");
	assert.deepEqual([night.start.getTime(), night.end.getTime()], [morning.start.getTime(), morning.end.getTime()]);
	assert.ok(morning.end.getTime() - morning.start.getTime() > 62 * DAY, "still more than one service call can answer");
});

test("an interval cut off by the start of the window has the same start and UID whenever it is fetched that day", async () => {
	sqlite = installSqlite("calPubRev", { schema });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	// A long event over the start of the window (8 Jan 00:00Z).
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('a', 'u1', 'Trip', ${Date.UTC(2030, 0, 7, 20) / 1000}, ${Date.UTC(2030, 0, 8, 9) / 1000}, 1, 1)`);
	const early = new Date(Date.UTC(2030, 0, 15, 1, 5));
	const late = new Date(Date.UTC(2030, 0, 15, 22, 40));
	const first = await publishedBusy({}, "u1", early);
	const second = await publishedBusy({}, "u1", late);
	assert.deepEqual(first, second);
	assert.equal(first[0][0], Date.UTC(2030, 0, 8));
	const uids = (now, busy) => buildFreeBusyIcs(busy, { uid: "k", now }).match(/^UID:.*$/gm);
	assert.deepEqual(uids(early, first), uids(late, second));
});

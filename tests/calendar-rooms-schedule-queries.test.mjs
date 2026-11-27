import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// I-5: a room's schedule reads the viewer's grants once, however many organisers have booked it.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = { "@/db": "export function getDb(){return globalThis.roomQ.db}" };
const fixture = await loadFixture({ name: "room-q", entryPoint: "src/lib/calendar/room-schedule.ts", mocks });
const { listRoomEvents } = await fixture.import();
let sqlite;
let statements = [];
after(() => { sqlite?.close(); delete globalThis.roomQ; fixture.dispose(); });

const T0 = Date.UTC(2030, 0, 7);
const secs = (ms) => Math.floor(ms / 1000);
const range = { start: new Date(T0), end: new Date(T0 + 86_400_000) };

function setup(organisers) {
	sqlite?.close();
	sqlite = installSqlite("roomQ", { schema, beforeQuery: (sql) => { statements.push(sql); } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('me', 'me@one.test', 'Me', 'x', 'user', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	for (let index = 0; index < organisers; index += 1) {
		const user = `o${index}`;
		sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${user}', '${user}@one.test', 'O', 'x', 'user', 1)`);
		sqlite.exec(`INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:x${index}', '${user}', 'calendar', 'Extra', 1, 1)`);
		// Every organiser has an event in their default calendar and one in an extra calendar.
		for (const [suffix, calendar] of [["a", null], ["b", `cal:x${index}`]]) {
			sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)").run(`e${index}${suffix}`, user, calendar, `Title ${index}${suffix}`, secs(T0 + (index % 20) * 3_600_000), secs(T0 + (index % 20) * 3_600_000 + 1800), );
			sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, 'r1', ?, 'accepted', 1)").run(`b${index}${suffix}`, `e${index}${suffix}`);
		}
	}
	// Reads the first organiser's default calendar and the second one's extra calendar in full; everything else is busy only.
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:o0', 'o0', 'calendar', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g0', 'cal:o0', 'me', 'read', 1), ('g1', 'cal:x1', 'me', 'edit', 1)");
	return globalThis.roomQ.db;
}
const run = async (organisers) => {
	const db = setup(organisers);
	statements = [];
	const { events } = await listRoomEvents(db, { id: "me" }, ["r1"], range);
	return { events, count: statements.length };
};

test("the number of queries does not grow with the number of organisers", async () => {
	const few = await run(3);
	const many = await run(40);
	assert.equal(few.events.length, 6);
	assert.equal(many.events.length, 80);
	assert.equal(many.count, few.count, `${few.count} queries for 3 organisers, ${many.count} for 40`);
});

test("what each viewer may read is unchanged: titles for a read grant on a default calendar and an edit grant on another, Busy for the rest", async () => {
	const { events } = await run(4);
	const title = Object.fromEntries(events.map((event) => [event.id, event.title]));
	assert.equal(title.e0a, "Title 0a", "read on the default calendar of o0");
	assert.equal(title.e0b, "Busy", "no grant on o0's extra calendar");
	assert.equal(title.e1b, "Title 1b", "edit on o1's extra calendar");
	assert.equal(title.e1a, "Busy");
	assert.equal(title.e2a, "Busy");
	sqlite.exec("UPDATE users SET disabled = 1 WHERE id = 'o0'");
	const { events: again } = await listRoomEvents(globalThis.roomQ.db, { id: "me" }, ["r1"], range);
	assert.equal(again.find((event) => event.id === "e0a").title, "Busy", "a disabled owner opens nothing");
	sqlite.exec("UPDATE calendar_events SET user_id = 'me' WHERE id = 'e3a'");
	const { events: own } = await listRoomEvents(globalThis.roomQ.db, { id: "me" }, ["r1"], range);
	assert.equal(own.find((event) => event.id === "e3a").title, "Title 3a", "my own event");
});

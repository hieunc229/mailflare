import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const COLUMNS_MIGRATION = "0106_calendar_columns.sql";

function database({ before = null } = {}) {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	for (const migration of migrations) {
		if (before && migration.name >= before) break;
		for (const statement of migration.statements) db.exec(statement);
	}
	return db;
}

const addUser = (db, id) => db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, 'U', 'x', 'user', 1)").run(id, `${id}@one.test`);
const addCollection = (db, id, userId) => db.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES (?, ?, 'calendar', 1, 1)").run(id, userId);
const addEvent = (db, id, userId = "u1", calendarId = null, extra = {}) =>
	db.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, dav_object_id, created_at, updated_at) VALUES (?, ?, ?, 'Standup', 100, 200, ?, 1, 1)").run(id, userId, calendarId, extra.davObjectId ?? null);
const log = (db) => db.prepare("SELECT collection_id AS c, object_key AS k, change_type AS t, resource_name AS n FROM dav_changes ORDER BY seq").all();

test("the migration adds the three columns with inert defaults", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	const row = db.prepare("SELECT calendar_id, is_private, transparent FROM calendar_events WHERE id = 'e1'").get();
	assert.deepEqual(row, { calendar_id: null, is_private: 0, transparent: 0 });
	const indexes = db.prepare("PRAGMA index_list(calendar_events)").all().map((index) => index.name);
	assert.ok(indexes.includes("calendar_events_calendar_starts_idx"));
});

test("applying the migration to a database with events writes no change-log rows", () => {
	const db = database({ before: COLUMNS_MIGRATION });
	addUser(db, "u1");
	db.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'u1', 'Old', 100, 200, 1, 1)").run();
	const before = log(db).length;
	for (const migration of migrations.filter((item) => item.name === COLUMNS_MIGRATION)) for (const statement of migration.statements) db.exec(statement);
	assert.equal(log(db).length, before);
	assert.equal(db.prepare("SELECT is_private FROM calendar_events WHERE id = 'e1'").get().is_private, 0);
});

test("an event without a calendar id is still logged in the owner's default collection", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET title = 'Changed' WHERE id = 'e1'").run();
	assert.deepEqual(log(db).map(({ c, t }) => [c, t]), [["cal:u1", "created"], ["cal:u1", "updated"]]);
});

test("an event in another calendar is logged in that collection", () => {
	const db = database();
	addUser(db, "u1");
	addCollection(db, "cal:work", "u1");
	addEvent(db, "e1", "u1", "cal:work");
	db.prepare("UPDATE calendar_events SET title = 'Changed' WHERE id = 'e1'").run();
	db.prepare("DELETE FROM calendar_events WHERE id = 'e1'").run();
	assert.deepEqual(log(db).map(({ c, t }) => [c, t]), [["cal:work", "created"], ["cal:work", "updated"], ["cal:work", "destroyed"]]);
});

test("the default calendar's own id as calendar_id is the same collection as null", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1", "u1", "cal:u1");
	assert.deepEqual(log(db).map(({ c }) => c), ["cal:u1"]);
});

test("moving an event between calendars destroys it in the old collection, under its resource name, and creates it in the new one", () => {
	const db = database();
	addUser(db, "u1");
	addCollection(db, "cal:work", "u1");
	addEvent(db, "e1", "u1", null, { davObjectId: "e1" });
	db.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('e1', 'u1', 'cal:u1', 'phone.ics', 'uid-1', 10, 1, 1)").run();
	db.prepare("UPDATE calendar_events SET calendar_id = 'cal:work' WHERE id = 'e1'").run();
	assert.deepEqual(log(db), [
		{ c: "cal:u1", k: "e1", t: "created", n: null },
		{ c: "cal:u1", k: "e1", t: "destroyed", n: "phone.ics" },
		{ c: "cal:work", k: "e1", t: "created", n: null },
	]);
	db.prepare("UPDATE calendar_events SET calendar_id = NULL WHERE id = 'e1'").run();
	assert.deepEqual(log(db).slice(3).map(({ c, t }) => [c, t]), [["cal:work", "destroyed"], ["cal:u1", "created"]]);
});

test("moving to another user and another calendar at once destroys in the old computed collection", () => {
	const db = database();
	addUser(db, "u1");
	addUser(db, "u2");
	addCollection(db, "cal:work", "u1");
	addEvent(db, "e1", "u1", "cal:work");
	db.prepare("UPDATE calendar_events SET user_id = 'u2', calendar_id = NULL WHERE id = 'e1'").run();
	assert.deepEqual(log(db).slice(1).map(({ c, t }) => [c, t]), [["cal:work", "destroyed"], ["cal:u2", "created"]]);
});

test("changing is_private or transparent is a content change", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET is_private = 1 WHERE id = 'e1'").run();
	db.prepare("UPDATE calendar_events SET transparent = 1 WHERE id = 'e1'").run();
	db.prepare("UPDATE calendar_events SET transparent = 1 WHERE id = 'e1'").run();
	assert.deepEqual(log(db).map(({ t }) => t), ["created", "updated", "updated"]);
});

test("an override row in another calendar is keyed under its parent in that calendar", () => {
	const db = database();
	addUser(db, "u1");
	addCollection(db, "cal:work", "u1");
	addEvent(db, "m1", "u1", "cal:work", { davObjectId: "m1" });
	addEvent(db, "o1", "u1", "cal:work", { davObjectId: "m1" });
	db.prepare("DELETE FROM calendar_events WHERE id = 'o1'").run();
	assert.deepEqual(log(db).map(({ c, k, t }) => [c, k, t]), [["cal:work", "m1", "created"], ["cal:work", "m1", "updated"], ["cal:work", "m1", "updated"]]);
});

test("deleting a calendar's events by statement logs each as destroyed in it", () => {
	const db = database();
	addUser(db, "u1");
	addCollection(db, "cal:work", "u1");
	addEvent(db, "e1", "u1", "cal:work");
	addEvent(db, "e2", "u1", "cal:work");
	db.prepare("DELETE FROM calendar_events WHERE calendar_id = 'cal:work'").run();
	db.prepare("DELETE FROM dav_collections WHERE id = 'cal:work'").run();
	assert.deepEqual(log(db).filter((row) => row.t === "destroyed").map((row) => [row.c, row.k]), [["cal:work", "e1"], ["cal:work", "e2"]]);
});

test("calendar_shares: one grant per grantee and calendar, many grants with no grantee, cascades from the calendar and the user", () => {
	const db = database();
	addUser(db, "u1");
	addUser(db, "u2");
	addCollection(db, "cal:work", "u1");
	const grant = (id, grantee) => db.prepare("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES (?, 'cal:work', ?, 'read', 1)").run(id, grantee);
	grant("csh_1", "u2");
	assert.throws(() => grant("csh_2", "u2"), /UNIQUE/);
	grant("csh_3", null);
	grant("csh_4", null);
	db.prepare("DELETE FROM users WHERE id = 'u2'").run();
	assert.deepEqual(db.prepare("SELECT id FROM calendar_shares ORDER BY id").all().map((row) => row.id), ["csh_3", "csh_4"]);
	db.prepare("DELETE FROM dav_collections WHERE id = 'cal:work'").run();
	assert.equal(db.prepare("SELECT count(*) AS n FROM calendar_shares").get().n, 0);
});

test("D-3: a group grantee column can be added later with ALTER TABLE ADD COLUMN, no rebuild", () => {
	const db = database();
	db.exec("CREATE TABLE groups (id TEXT PRIMARY KEY)");
	db.exec("ALTER TABLE calendar_shares ADD COLUMN grantee_group_id TEXT REFERENCES groups(id) ON DELETE CASCADE");
	db.exec("CREATE UNIQUE INDEX calendar_shares_group_idx ON calendar_shares (calendar_id, grantee_group_id)");
	assert.ok(db.prepare("PRAGMA table_info(calendar_shares)").all().some((column) => column.name === "grantee_group_id"));
});

test("resources are unique by name; a booking is unique per resource and event and cascades from both", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('res_1', 'Room A', 1, 1)").run();
	assert.throws(() => db.prepare("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('res_2', 'Room A', 1, 1)").run(), /UNIQUE/);
	assert.deepEqual(db.prepare("SELECT kind, capacity, location, description, disabled FROM calendar_resources WHERE id = 'res_1'").get(), { kind: "room", capacity: null, location: "", description: "", disabled: 0 });
	const book = (id) => db.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, 'res_1', 'e1', 'accepted', 1)").run(id);
	book("crb_1");
	assert.throws(() => book("crb_2"), /UNIQUE/);
	db.prepare("DELETE FROM calendar_events WHERE id = 'e1'").run();
	assert.equal(db.prepare("SELECT count(*) AS n FROM calendar_resource_bookings").get().n, 0);
});

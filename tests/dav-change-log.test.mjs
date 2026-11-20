import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const DAV_MIGRATION = "0098_dav_storage.sql";
const MODEL_MIGRATION = "0103_calendar_event_rrule.sql";

function database({ until = null, foreignKeys = true } = {}) {
	const db = new Database(":memory:");
	db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
	for (const migration of migrations) {
		if (until && migration.name >= until) break;
		for (const statement of migration.statements) db.exec(statement);
	}
	return db;
}

function addUser(db, id) {
	db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, 'U', 'x', 'user', 1)").run(id, `${id}@one.test`);
}

function addEvent(db, id, userId = "u1", extra = "") {
	db.prepare(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, ?, 'Standup', 100, 200, 1, 1${extra ? ", " + extra.split("=")[1] : ""})`).run(id, userId);
}

const log = (db, collection = null) =>
	db
		.prepare("SELECT collection_id AS c, object_key AS k, change_type AS t FROM dav_changes WHERE (? IS NULL OR collection_id = ?) ORDER BY seq")
		.all(collection, collection);

test("an inserted event is logged as created in its owner's calendar collection", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	assert.deepEqual(log(db), [{ c: "cal:u1", k: "e1", t: "created" }]);
});

test("a content change is logged as updated and the next sequence number is higher", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET title = 'Stand-up' WHERE id = 'e1'").run();
	db.prepare("UPDATE calendar_events SET reminder_minutes = 10 WHERE id = 'e1'").run();
	const rows = db.prepare("SELECT seq, change_type AS t FROM dav_changes ORDER BY seq").all();
	assert.deepEqual(rows.map((r) => r.t), ["created", "updated", "updated"]);
	assert.ok(rows[0].seq < rows[1].seq && rows[1].seq < rows[2].seq);
});

test("only the reminder bookkeeping column changing writes nothing", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET last_reminded_start = 150 WHERE id = 'e1'").run();
	assert.equal(log(db).length, 1);
});

test("an update that leaves every value unchanged writes nothing, so the ETag stays put", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET title = 'Standup', updated_at = 1, description = '' WHERE id = 'e1'").run();
	assert.equal(log(db).length, 1);
});

test("a change to a nullable column from or to NULL is detected", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET repeat_until = 500 WHERE id = 'e1'").run();
	db.prepare("UPDATE calendar_events SET repeat_until = NULL WHERE id = 'e1'").run();
	assert.deepEqual(log(db).map((r) => r.t), ["created", "updated", "updated"]);
});

test("moving an event to another user destroys it for the old owner and creates it for the new one", () => {
	const db = database();
	addUser(db, "u1");
	addUser(db, "u2");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET user_id = 'u2' WHERE id = 'e1'").run();
	assert.deepEqual(log(db), [
		{ c: "cal:u1", k: "e1", t: "created" },
		{ c: "cal:u1", k: "e1", t: "destroyed" },
		{ c: "cal:u2", k: "e1", t: "created" },
	]);
});

test("deleting an event, directly or by deleting its user, is logged as destroyed", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	addEvent(db, "e2");
	db.prepare("DELETE FROM calendar_events WHERE id = 'e1'").run();
	db.prepare("DELETE FROM users WHERE id = 'u1'").run();
	assert.deepEqual(log(db).filter((r) => r.t === "destroyed").map((r) => r.k), ["e1", "e2"]);
});

test("sequence numbers never repeat after the newest row is pruned", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	const first = db.prepare("SELECT max(seq) AS s FROM dav_changes").get().s;
	db.prepare("DELETE FROM dav_changes").run();
	addEvent(db, "e2");
	assert.ok(db.prepare("SELECT max(seq) AS s FROM dav_changes").get().s > first);
});

test("card inserts, updates and deletes are logged under the card collection", () => {
	const db = database();
	addUser(db, "u1");
	db.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', 1, 1)").run();
	db.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('c1', 'u1', 'card:u1', 'c1.vcf', 'uid-1', 'BEGIN:VCARD', '3.0', 11, 1, 1)").run();
	db.prepare("UPDATE dav_cards SET body = 'BEGIN:VCARD\nEND:VCARD' WHERE id = 'c1'").run();
	db.prepare("DELETE FROM dav_cards WHERE id = 'c1'").run();
	assert.deepEqual(log(db, "card:u1"), [
		{ c: "card:u1", k: "c1", t: "created" },
		{ c: "card:u1", k: "c1", t: "updated" },
		{ c: "card:u1", k: "c1", t: "destroyed" },
	]);
});

test("the migration seeds one created row for every event that already existed", () => {
	const db = database({ until: DAV_MIGRATION });
	addUser(db, "u1");
	addUser(db, "u2");
	addEvent(db, "e1", "u1");
	addEvent(db, "e2", "u2");
	const migration = migrations.find((m) => m.name === DAV_MIGRATION);
	for (const statement of migration.statements) db.exec(statement);
	assert.deepEqual(log(db).sort((a, b) => a.k.localeCompare(b.k)), [
		{ c: "cal:u1", k: "e1", t: "created" },
		{ c: "cal:u2", k: "e2", t: "created" },
	]);
});

test("a calendar object body goes away with its event, and does not write to the change log itself", () => {
	const db = database();
	addUser(db, "u1");
	db.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:u1', 'u1', 'calendar', 1, 1)").run();
	addEvent(db, "e1");
	db.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, body, size, created_at, updated_at) VALUES ('e1', 'u1', 'cal:u1', 'e1.ics', 'e1@mailflare', 'BEGIN:VCALENDAR', 15, 1, 1)").run();
	db.prepare("UPDATE dav_calendar_objects SET body = 'x', rows_hash = 'h' WHERE id = 'e1'").run();
	assert.equal(log(db).length, 1);
	db.prepare("DELETE FROM calendar_events WHERE id = 'e1'").run();
	assert.equal(db.prepare("SELECT count(*) AS n FROM dav_calendar_objects").get().n, 0);
});

test("a collection name and a uid are unique inside a collection", () => {
	const db = database();
	addUser(db, "u1");
	db.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('card:u1', 'u1', 'addressbook', 1, 1)").run();
	const insert = db.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES (?, 'u1', 'card:u1', ?, ?, 'b', '3.0', 1, 1, 1)");
	insert.run("c1", "a.vcf", "uid-1");
	assert.throws(() => insert.run("c2", "a.vcf", "uid-2"), /UNIQUE/);
	assert.throws(() => insert.run("c3", "b.vcf", "uid-1"), /UNIQUE/);
});

test("moving a card to another collection destroys it in the old one and creates it in the new one", () => {
	const db = database();
	addUser(db, "u1");
	db.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('c1', 'u1', 'card:a', 'c1.vcf', 'uid-1', 'b', '3.0', 1, 1, 1)").run();
	db.prepare("UPDATE dav_cards SET collection_id = 'card:b' WHERE id = 'c1'").run();
	assert.deepEqual(log(db), [
		{ c: "card:a", k: "c1", t: "created" },
		{ c: "card:a", k: "c1", t: "destroyed" },
		{ c: "card:b", k: "c1", t: "created" },
	]);
});

test("a card update that leaves every watched value unchanged writes nothing", () => {
	const db = database();
	addUser(db, "u1");
	db.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('c1', 'u1', 'card:a', 'c1.vcf', 'uid-1', 'b', '3.0', 1, 1, 1)").run();
	db.prepare("UPDATE dav_cards SET body = 'b', fn = '' WHERE id = 'c1'").run();
	assert.equal(log(db).length, 1);
});

// A column added to calendar_events without recreating the triggers would silently stop ETags and sync tokens moving.
test("every calendar_events column is watched by the triggers of all three migrations", () => {
	const unwatched = new Set(["id", "created_at", "last_reminded_start"]);
	const columns = database().prepare("PRAGMA table_info(calendar_events)").all().map((c) => c.name).filter((name) => !unwatched.has(name)).sort();
	for (const file of ["migrations/0103_calendar_event_rrule.sql", "migrations-pg/0027_calendar_event_rrule.sql", "migrations-mysql/0027_calendar_event_rrule.sql"]) {
		const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
		const start = sql.search(/dav_calendar_changed|dav_changes_calendar_events_ai/);
		const end = sql.slice(start).search(/dav_card_changed|dav_changes_cards_ai|$/);
		const section = sql.slice(start, start + end);
		const referenced = [...new Set([...section.matchAll(/\b(?:OLD|NEW)\.`?(\w+)`?/g)].map((m) => m[1]))].filter((name) => name !== "id").sort();
		assert.deepEqual(referenced, columns, file);
	}
});

const master = (db, id, userId = "u1") => db.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, dav_object_id) VALUES (?, ?, 'Series', 100, 200, 1, 1, ?)").run(id, userId, id);
const override = (db, id, parent, userId = "u1") => db.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, dav_object_id, recurrence_id) VALUES (?, ?, 'Moved', 300, 400, 1, 1, ?, 100)").run(id, userId, parent);

test("a DAV master row is created under its own key, an override row reports its parent as updated", () => {
	const db = database();
	addUser(db, "u1");
	master(db, "m1");
	override(db, "o1", "m1");
	assert.deepEqual(log(db), [{ c: "cal:u1", k: "m1", t: "created" }, { c: "cal:u1", k: "m1", t: "updated" }]);
});

test("changing only one of the new columns is a change", () => {
	for (const set of ["rrule = 'FREQ=DAILY'", "recurrence_id = 5", "all_day = 1"]) {
		const db = database();
		addUser(db, "u1");
		addEvent(db, "e1");
		db.prepare(`UPDATE calendar_events SET ${set} WHERE id = 'e1'`).run();
		assert.equal(log(db).length, 2, set);
	}
});

test("a row that moves to another DAV resource changes both the old and the new resource", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET dav_object_id = 'm9' WHERE id = 'e1'").run();
	assert.deepEqual(log(db).slice(1).map((r) => `${r.k}:${r.t}`).sort(), ["e1:updated", "m9:updated"]);
});

test("a native row that becomes a DAV master keeps its key and reads as updated", () => {
	const db = database();
	addUser(db, "u1");
	addEvent(db, "e1");
	db.prepare("UPDATE calendar_events SET dav_object_id = 'e1' WHERE id = 'e1'").run();
	assert.deepEqual(log(db), [{ c: "cal:u1", k: "e1", t: "created" }, { c: "cal:u1", k: "e1", t: "updated" }]);
});

test("editing an override row updates the parent resource, not a resource of its own", () => {
	const db = database();
	addUser(db, "u1");
	master(db, "m1");
	override(db, "o1", "m1");
	db.prepare("UPDATE calendar_events SET title = 'Moved again' WHERE id = 'o1'").run();
	assert.deepEqual(log(db).map((r) => `${r.k}:${r.t}`), ["m1:created", "m1:updated", "m1:updated"]);
});

test("deleting an override row reports the parent as updated; deleting the master destroys the resource", () => {
	const db = database();
	addUser(db, "u1");
	master(db, "m1");
	override(db, "o1", "m1");
	db.prepare("DELETE FROM dav_changes").run();
	db.prepare("DELETE FROM calendar_events WHERE id = 'o1'").run();
	assert.deepEqual(log(db), [{ c: "cal:u1", k: "m1", t: "updated" }]);
	db.prepare("DELETE FROM calendar_events WHERE id = 'm1'").run();
	assert.deepEqual(log(db).map((r) => r.t), ["updated", "destroyed"]);
});

test("deleting a user never logs an override after its resource was destroyed", () => {
	for (const order of [["m1", "o1"], ["o1", "m1"]]) {
		const db = database();
		addUser(db, "u1");
		master(db, "m1");
		override(db, "o1", "m1");
		for (const id of order) db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
		assert.equal(log(db).at(-1).t, "destroyed", order.join());
	}
});

test("moving an override to another user only touches the new owner's collection", () => {
	const db = database();
	addUser(db, "u1");
	addUser(db, "u2");
	master(db, "m1");
	override(db, "o1", "m1");
	db.prepare("DELETE FROM dav_changes").run();
	db.prepare("UPDATE calendar_events SET user_id = 'u2' WHERE id = 'o1'").run();
	assert.deepEqual(log(db), [{ c: "cal:u2", k: "m1", t: "updated" }]);
});

test("moving a DAV master to another user destroys and creates the resource like any event", () => {
	const db = database();
	addUser(db, "u1");
	addUser(db, "u2");
	master(db, "m1");
	db.prepare("UPDATE calendar_events SET user_id = 'u2' WHERE id = 'm1'").run();
	assert.deepEqual(log(db).map((r) => `${r.c}:${r.t}`), ["cal:u1:created", "cal:u1:destroyed", "cal:u2:created"]);
});

test("the F6-2 migration leaves existing repeat fields and change rows alone and defaults the new columns", () => {
	const db = database({ until: MODEL_MIGRATION });
	addUser(db, "u1");
	db.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, repeat, repeat_days, repeat_anchor_day, repeat_until, excluded_occurrences) VALUES ('e1', 'u1', 'Gym', 100, 200, 1, 1, 'weekdays', '[1,3]', 7, 900, '[100]')").run();
	const before = db.prepare("SELECT * FROM calendar_events").get();
	const seq = db.prepare("SELECT count(*) AS n FROM dav_changes").get().n;
	for (const statement of migrations.find((m) => m.name === MODEL_MIGRATION).statements) db.exec(statement);
	const after = db.prepare("SELECT * FROM calendar_events").get();
	assert.deepEqual({ ...after, rrule: undefined, recurrence_id: undefined, dav_object_id: undefined, all_day: undefined }, { ...before, rrule: undefined, recurrence_id: undefined, dav_object_id: undefined, all_day: undefined });
	assert.deepEqual([after.rrule, after.recurrence_id, after.dav_object_id, after.all_day], [null, null, null, 0]);
	assert.equal(db.prepare("SELECT count(*) AS n FROM dav_changes").get().n, seq);
});

// F6-5: a destroyed resource keeps the name it was served under, so sync-collection can report it as gone under that name.
const names = (db) => db.prepare("SELECT object_key AS k, change_type AS t, resource_name AS n FROM dav_changes ORDER BY seq").all();

test("destroying a DAV-named event records its resource name; a native event records none", () => {
	const db = database();
	addUser(db, "u1");
	master(db, "m1");
	db.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('m1', 'u1', 'cal:u1', 'phone-made.ics', 'uid-1', 1, 1, 1)").run();
	addEvent(db, "e1");
	db.prepare("DELETE FROM calendar_events WHERE id IN ('m1', 'e1')").run();
	const destroyed = names(db).filter((r) => r.t === "destroyed");
	assert.deepEqual(Object.fromEntries(destroyed.map((r) => [r.k, r.n])), { m1: "phone-made.ics", e1: null });
});

test("deleting a master and its override in one statement logs the destroyed master once and no stray update", () => {
	const db = database();
	addUser(db, "u1");
	master(db, "m1");
	override(db, "o1", "m1");
	db.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('m1', 'u1', 'cal:u1', 'series.ics', 'uid-1', 1, 1, 1)").run();
	db.prepare("DELETE FROM dav_changes").run();
	db.prepare("DELETE FROM calendar_events WHERE id IN ('m1', 'o1')").run();
	assert.deepEqual(names(db), [{ k: "m1", t: "destroyed", n: "series.ics" }]);
});

test("deleting a user's cards and events records the names", () => {
	const db = database();
	addUser(db, "u1");
	db.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('c1', 'u1', 'card:u1', 'ada.vcf', 'uid-1', 'b', '3.0', 1, 1, 1)").run();
	master(db, "m1");
	db.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('m1', 'u1', 'cal:u1', 'series.ics', 'uid-1', 1, 1, 1)").run();
	db.prepare("DELETE FROM users WHERE id = 'u1'").run();
	const destroyed = Object.fromEntries(names(db).filter((r) => r.t === "destroyed").map((r) => [r.k, r.n]));
	assert.deepEqual(destroyed, { c1: "ada.vcf", m1: "series.ics" });
});

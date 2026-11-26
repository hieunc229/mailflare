import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-cal-review-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { calendars: join(root, "src/lib/calendar/calendars.ts"), schema: join(root, "src/db/schema/index.ts") }, outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@": join(root, "src") },
	external: ["better-sqlite3", "pg", "postgres", "mysql2", "@neondatabase/serverless", "@planetscale/database", "@libsql/client", "@electric-sql/pglite", "bun:sqlite", "cloudflare:workers"],
});
const lib = await import(pathToFileURL(join(dir, "calendars.mjs")).href);
const { calendarEvents } = await import(pathToFileURL(join(dir, "schema.mjs")).href);
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

/** drizzle over better-sqlite3 has no batch(); this one runs the statements in a transaction like D1 does. */
function setup() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	for (const id of ["u1", "u2"]) sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, 'U', 'x', 'user', 1)").run(id, `${id}@one.test`);
	const orm = drizzle(sqlite);
	const batches = [];
	orm.batch = async (statements) => {
		batches.push(statements.length);
		sqlite.exec("BEGIN");
		try { for (const statement of statements) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
	};
	const event = (id, user = "u1", calendarId = null, dav = null, recurrence = null) =>
		sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at, dav_object_id, recurrence_id) VALUES (?, ?, ?, 'E', 1000, 2000, 1, 1, ?, ?)").run(id, user, calendarId, dav, recurrence);
	return { sqlite, orm, batches, event };
}
const addCollection = (sqlite, id, user = "u1") => sqlite.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES (?, ?, 'calendar', 1, 1)").run(id, user);

test("deleting a calendar also deletes override rows that lost their calendar, re-keys its change log to the default calendar, in one batch", async () => {
	const { sqlite, orm, batches, event } = setup();
	addCollection(sqlite, "cal:work");
	event("m1", "u1", "cal:work", "m1");
	event("stray", "u1", null, "m1", 100);
	event("keep", "u1", null);
	const result = await lib.deleteCalendar(orm, "u1", "cal:work");
	assert.equal(result.ok, true);
	assert.deepEqual(sqlite.prepare("SELECT id FROM calendar_events").all().map((row) => row.id), ["keep"]);
	assert.equal(batches.length, 1);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_changes WHERE collection_id = 'cal:work'").get().n, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_changes WHERE collection_id = 'cal:u1' AND object_key = 'm1' AND change_type = 'destroyed'").get().n, 1);
});

test("deleting a calendar with hundreds of series stays under the bound-parameter limit per statement", async () => {
	const { sqlite, orm, event } = setup();
	addCollection(sqlite, "cal:work");
	sqlite.exec("BEGIN");
	for (let index = 0; index < 250; index += 1) event(`m${index}`, "u1", "cal:work", `m${index}`);
	sqlite.exec("COMMIT");
	const statements = [];
	const logged = drizzle(sqlite, { logger: { logQuery: (query, params) => statements.push(params.length) } });
	logged.batch = orm.batch;
	assert.equal((await lib.deleteCalendar(logged, "u1", "cal:work")).ok, true);
	assert.ok(Math.max(...statements) <= 100, `max params ${Math.max(...statements)}`);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
});

test("the list carries each calendar's event count, the default's including the rows that name it", async () => {
	const { sqlite, orm, event } = setup();
	addCollection(sqlite, "cal:work");
	event("a"); event("b", "u1", "cal:u1"); event("c", "u1", "cal:work"); event("d", "u2");
	const list = await lib.listOwnCalendars(orm, "u1");
	assert.deepEqual(list.map((calendar) => [calendar.id, calendar.eventCount]), [["cal:u1", 2], ["cal:work", 1]]);
});

test("a create that loses the race for the last place is rolled back with 409", async () => {
	const { sqlite, orm } = setup();
	for (let index = 0; index < 48; index += 1) addCollection(sqlite, `cal:c${index}`);
	let raced = false;
	const racing = new Proxy(orm, { get(target, key) {
		if (key !== "insert") return typeof target[key] === "function" ? target[key].bind(target) : target[key];
		return (table) => { const builder = target.insert(table); return { values: (values) => { const run = builder.values(values); return { then: (resolve, reject) => Promise.resolve(run).then(() => { if (!raced) { raced = true; addCollection(sqlite, "cal:competitor"); } }).then(resolve, reject) }; } }; };
	} });
	const result = await lib.createCalendar(racing, "u1", { name: "Last place" });
	assert.deepEqual([result.ok, result.status], [false, 409]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_collections WHERE user_id = 'u1'").get().n, 49);
});

test("renaming the default calendar survives a competing lazy insert of its row", async () => {
	const { sqlite, orm } = setup();
	const racing = new Proxy(orm, { get(target, key) {
		if (key !== "insert") return typeof target[key] === "function" ? target[key].bind(target) : target[key];
		return (table) => { sqlite.prepare("INSERT OR IGNORE INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:u1', 'u1', 'calendar', 'Theirs', 1, 1)").run(); return target.insert(table); };
	} });
	assert.equal((await lib.updateCalendar(racing, "u1", "cal:u1", { name: "Mine" })).ok, true);
	assert.equal(sqlite.prepare("SELECT display_name FROM dav_collections WHERE id = 'cal:u1'").get().display_name, "Mine");
});

test("a non-string calendar id is a 400; naming the calendar the event already has keeps it, even when its row is gone", async () => {
	const { orm } = setup();
	for (const value of [5, {}, true]) assert.deepEqual([(await lib.resolveEventCalendar(orm, "u1", value)).ok, (await lib.resolveEventCalendar(orm, "u1", value)).status], [false, 400]);
	assert.deepEqual(await lib.resolveEventCalendar(orm, "u1", "cal:gone", "cal:gone"), { ok: true, calendarId: undefined });
	assert.equal((await lib.resolveEventCalendar(orm, "u1", "cal:gone", null)).status, 404);
});

test("an event in a calendar whose row is missing shows in the default calendar", async () => {
	const { sqlite, orm, event } = setup();
	addCollection(sqlite, "cal:work");
	event("orphan", "u1", "cal:gone"); event("work", "u1", "cal:work");
	assert.equal(lib.eventCalendarId({ calendarId: "cal:gone", userId: "u1" }, new Set(["cal:u1", "cal:work"])), "cal:u1");
	assert.equal(lib.eventCalendarId({ calendarId: "cal:work", userId: "u1" }, new Set(["cal:u1", "cal:work"])), "cal:work");
	assert.equal(lib.eventCalendarId({ calendarId: null, userId: "u1" }), "cal:u1");
	const ids = orm.select({ id: calendarEvents.id }).from(calendarEvents).where(lib.calendarFilter("u1", ["cal:u1"])).all().map((row) => row.id);
	assert.deepEqual(ids, ["orphan"]);
});

test("renaming a calendar whose stored colour is not in the palette leaves that colour alone", async () => {
	const { sqlite, orm } = setup();
	sqlite.prepare("INSERT INTO dav_collections (id, user_id, kind, display_name, color, created_at, updated_at) VALUES ('cal:phone', 'u1', 'calendar', 'Old', '#12ab34ff', 1, 1)").run();
	assert.equal((await lib.updateCalendar(orm, "u1", "cal:phone", { name: "New" })).ok, true);
	assert.deepEqual({ ...sqlite.prepare("SELECT display_name, color FROM dav_collections WHERE id = 'cal:phone'").get() }, { display_name: "New", color: "#12ab34ff" });
});

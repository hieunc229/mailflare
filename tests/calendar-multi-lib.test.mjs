import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-cal-multi-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { calendars: join(root, "src/lib/calendar/calendars.ts"), rows: join(root, "src/lib/calendar/series-rows.ts"), schema: join(root, "src/db/schema/index.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@": join(root, "src") },
	external: ["better-sqlite3", "pg", "postgres", "mysql2", "@neondatabase/serverless", "@planetscale/database", "@libsql/client", "@electric-sql/pglite", "bun:sqlite", "cloudflare:workers"],
});
const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const lib = await load("calendars");
const rows = await load("rows");
const { calendarEvents } = await load("schema");
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function setup() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	for (const id of ["u1", "u2"]) sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, 'U', 'x', 'user', 1)").run(id, `${id}@one.test`);
	const statements = [];
	const orm = drizzle(sqlite, { logger: { logQuery: (query) => statements.push(query) } });
	const event = (id, user = "u1", calendarId = null, dav = null, recurrence = null) =>
		sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at, dav_object_id, recurrence_id) VALUES (?, ?, ?, 'E', 1000, 2000, 1, 1, ?, ?)").run(id, user, calendarId, dav, recurrence);
	const calendarOf = (id) => sqlite.prepare("SELECT calendar_id FROM calendar_events WHERE id = ?").get(id).calendar_id;
	const log = () => sqlite.prepare("SELECT collection_id AS c, object_key AS k, change_type AS t FROM dav_changes ORDER BY seq").all();
	return { sqlite, orm, statements, event, calendarOf, log };
}

test("moving a master moves every override row in one statement, and the change log sees one move", async () => {
	const { sqlite, orm, statements, event, calendarOf, log } = setup();
	sqlite.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 1, 1)").run();
	event("m1", "u1", null, "m1");
	event("o1", "u1", null, "m1", 100);
	event("o2", "u1", null, "m1", 200);
	event("other", "u1");
	event("theirs", "u2", null, "theirs");
	event("theirs-o", "u2", null, "theirs", 100);
	const before = log().length;
	statements.length = 0;
	await rows.moveSeriesToCalendar(orm, "u1", "m1", "cal:work");
	assert.equal(statements.length, 1, `expected one statement, got: ${statements.join(" | ")}`);
	assert.deepEqual(["m1", "o1", "o2"].map(calendarOf), ["cal:work", "cal:work", "cal:work"]);
	assert.equal(calendarOf("other"), null);
	assert.equal(calendarOf("theirs"), null);
	assert.equal(calendarOf("theirs-o"), null);
	const entries = log().slice(before);
	// The master leaves the default collection and appears in the new one; overrides only ever update their parent in the new one.
	assert.deepEqual(entries.filter((entry) => entry.c === "cal:u1").map(({ k, t }) => [k, t]), [["m1", "destroyed"]]);
	assert.ok(entries.filter((entry) => entry.c === "cal:work").every((entry) => entry.k === "m1"));
	assert.equal(entries.filter((entry) => entry.t === "created").length, 1);
});

test("moving back to the default calendar stores null", async () => {
	const { sqlite, orm, event, calendarOf } = setup();
	sqlite.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 1, 1)").run();
	event("m1", "u1", "cal:work", "m1");
	event("o1", "u1", "cal:work", "m1", 100);
	await rows.moveSeriesToCalendar(orm, "u1", "m1", null);
	assert.deepEqual(["m1", "o1"].map(calendarOf), [null, null]);
});

test("a native event with no overrides moves alone", async () => {
	const { sqlite, orm, event, calendarOf } = setup();
	sqlite.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 1, 1)").run();
	event("a");
	event("b");
	await rows.moveSeriesToCalendar(orm, "u1", "a", "cal:work");
	assert.equal(calendarOf("a"), "cal:work");
	assert.equal(calendarOf("b"), null);
});

test("the default calendar is listed first and synthesised when it has no row", async () => {
	const { orm, sqlite } = setup();
	assert.deepEqual(await lib.listOwnCalendars(orm, "u1"), [{ id: "cal:u1", name: null, color: "#2563eb", description: "", isDefault: true, role: "owner" }]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_collections").get().n, 0);
});

test("creating a calendar stores a dav_collections row with its own id, colour and description", async () => {
	const { orm, sqlite } = setup();
	const result = await lib.createCalendar(orm, "u1", { name: "  Work ", color: "#7c3aed", description: "Team stuff" });
	assert.equal(result.ok, true);
	assert.match(result.calendar.id, /^cal:.+/);
	assert.notEqual(result.calendar.id, "cal:u1");
	assert.deepEqual({ ...result.calendar, id: undefined }, { id: undefined, name: "Work", color: "#7c3aed", description: "Team stuff", isDefault: false, role: "owner" });
	const row = sqlite.prepare("SELECT user_id, kind, display_name, color FROM dav_collections WHERE id = ?").get(result.calendar.id);
	assert.deepEqual({ ...row }, { user_id: "u1", kind: "calendar", display_name: "Work", color: "#7c3aed" });
	assert.deepEqual((await lib.listOwnCalendars(orm, "u1")).map((calendar) => calendar.name), [null, "Work"]);
	assert.deepEqual(await lib.listOwnCalendars(orm, "u2").then((list) => list.length), 1);
});

test("a calendar needs a name and a palette colour; long text is refused", async () => {
	const { orm, sqlite } = setup();
	for (const input of [{ name: "  " }, { name: "x".repeat(101) }, { name: "A", color: "red" }, { name: "A", description: "x".repeat(501) }, { name: 5 }]) {
		const result = await lib.createCalendar(orm, "u1", input);
		assert.equal(result.ok, false, JSON.stringify(input).slice(0, 40));
		assert.equal(result.status, 400);
	}
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_collections").get().n, 0);
});

test("a user may own 50 calendars including the default; the 51st is refused with 409", async () => {
	const { orm, sqlite } = setup();
	for (let index = 0; index < 49; index += 1) assert.equal((await lib.createCalendar(orm, "u1", { name: `C${index}` })).ok, true);
	const refused = await lib.createCalendar(orm, "u1", { name: "One too many" });
	assert.deepEqual([refused.ok, refused.status], [false, 409]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_collections WHERE user_id = 'u1'").get().n, 49);
	assert.equal((await lib.createCalendar(orm, "u2", { name: "Other user is unaffected" })).ok, true);
});

test("renaming the default calendar creates its row lazily under cal:<userId>; a second rename updates it", async () => {
	const { orm, sqlite } = setup();
	const first = await lib.updateCalendar(orm, "u1", "cal:u1", { name: "Personal", color: "#16a34a" });
	assert.equal(first.ok, true);
	assert.deepEqual({ ...sqlite.prepare("SELECT id, user_id, kind, display_name, color FROM dav_collections").get() }, { id: "cal:u1", user_id: "u1", kind: "calendar", display_name: "Personal", color: "#16a34a" });
	assert.equal((await lib.updateCalendar(orm, "u1", "cal:u1", { name: "Home" })).ok, true);
	const [calendar] = await lib.listOwnCalendars(orm, "u1");
	assert.deepEqual([calendar.name, calendar.color, calendar.isDefault], ["Home", "#16a34a", true]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_collections").get().n, 1);
});

test("updating changes only the fields sent and refuses calendars the user does not own", async () => {
	const { orm } = setup();
	const { calendar } = await lib.createCalendar(orm, "u1", { name: "Work", color: "#dc2626", description: "d" });
	const result = await lib.updateCalendar(orm, "u1", calendar.id, { description: "new" });
	assert.deepEqual([result.calendar.name, result.calendar.color, result.calendar.description], ["Work", "#dc2626", "new"]);
	assert.deepEqual((await lib.updateCalendar(orm, "u2", calendar.id, { name: "Mine now" })).status, 404);
	assert.deepEqual((await lib.updateCalendar(orm, "u1", "cal:nope", { name: "x" })).status, 404);
	assert.deepEqual((await lib.updateCalendar(orm, "u1", calendar.id, { name: "" })).status, 400);
});

test("deleting a calendar deletes its events first so the phone sees them destroyed, then the calendar and its grants", async () => {
	const { orm, sqlite, event, log } = setup();
	const { calendar } = await lib.createCalendar(orm, "u1", { name: "Work" });
	event("e1", "u1", calendar.id);
	event("e2", "u1", calendar.id);
	event("keep", "u1", null);
	sqlite.prepare("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('csh_1', ?, 'u2', 'read', 1)").run(calendar.id);
	const result = await lib.deleteCalendar(orm, "u1", calendar.id);
	assert.deepEqual([result.ok, result.eventCount, result.name], [true, 2, "Work"]);
	assert.deepEqual(sqlite.prepare("SELECT id FROM calendar_events").all().map((row) => row.id), ["keep"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_collections").get().n, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_shares").get().n, 0);
	assert.deepEqual(log().filter((entry) => entry.t === "destroyed" && entry.c === calendar.id).map((entry) => entry.k), ["e1", "e2"]);
});

test("the default calendar cannot be deleted (409), nor another user's calendar (404)", async () => {
	const { orm, event, sqlite } = setup();
	event("e1");
	assert.equal((await lib.deleteCalendar(orm, "u1", "cal:u1")).status, 409);
	const { calendar } = await lib.createCalendar(orm, "u1", { name: "Work" });
	assert.equal((await lib.deleteCalendar(orm, "u2", calendar.id)).status, 404);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM dav_collections").get().n, 1);
});

test("resolveEventCalendar maps the default to null, accepts owned calendars and rejects the rest", async () => {
	const { orm } = setup();
	const { calendar } = await lib.createCalendar(orm, "u1", { name: "Work" });
	assert.deepEqual(await lib.resolveEventCalendar(orm, "u1", undefined), { ok: true, calendarId: undefined });
	assert.deepEqual(await lib.resolveEventCalendar(orm, "u1", null), { ok: true, calendarId: null });
	assert.deepEqual(await lib.resolveEventCalendar(orm, "u1", "cal:u1"), { ok: true, calendarId: null });
	assert.deepEqual(await lib.resolveEventCalendar(orm, "u1", calendar.id), { ok: true, calendarId: calendar.id });
	for (const value of ["cal:u2", "cal:missing", 7]) assert.equal((await lib.resolveEventCalendar(orm, "u1", value)).ok, false);
	assert.equal((await lib.resolveEventCalendar(orm, "u2", calendar.id)).status, 404);
});

test("calendarFilter selects the default calendar's null rows and named calendars' rows, never another user's", async () => {
	const { orm, event } = setup();
	const { calendar } = await lib.createCalendar(orm, "u1", { name: "Work" });
	const other = await lib.createCalendar(orm, "u1", { name: "Other" });
	event("def-null"); event("def-explicit", "u1", "cal:u1"); event("work", "u1", calendar.id); event("other", "u1", other.calendar.id); event("u2", "u2");
	const ids = (calendarIds) => orm.select({ id: calendarEvents.id }).from(calendarEvents).where(lib.calendarFilter("u1", calendarIds)).all().map((row) => row.id).sort();
	assert.deepEqual(ids(["cal:u1"]), ["def-explicit", "def-null"]);
	assert.deepEqual(ids([calendar.id]), ["work"]);
	assert.deepEqual(ids(["cal:u1", other.calendar.id]), ["def-explicit", "def-null", "other"]);
	assert.deepEqual(ids([]), []);
	assert.deepEqual(ids(["cal:u2"]), []);
});

test("transferCalendars moves the source's extra calendars, keeps default events default, drops the recipient's grants on them", async () => {
	const { orm, sqlite, event } = setup();
	const { calendar } = await lib.createCalendar(orm, "u1", { name: "Work" });
	await lib.updateCalendar(orm, "u1", "cal:u1", { name: "Mine" });
	event("w1", "u1", calendar.id);
	event("d1", "u1", "cal:u1");
	event("d2", "u1", null);
	sqlite.prepare("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('csh_1', ?, 'u2', 'edit', 1), ('csh_2', ?, NULL, 'read', 1)").run(calendar.id, calendar.id);
	const moved = await lib.transferCalendars(orm, "u1", "u2");
	assert.deepEqual(moved, [calendar.id]);
	assert.equal(sqlite.prepare("SELECT user_id FROM dav_collections WHERE id = ?").get(calendar.id).user_id, "u2");
	assert.equal(sqlite.prepare("SELECT user_id FROM dav_collections WHERE id = 'cal:u1'").get().user_id, "u1");
	// Events still carry the source's user id here; the caller's own statement changes it. The default-calendar spelling is normalised to null.
	assert.equal(sqlite.prepare("SELECT calendar_id FROM calendar_events WHERE id = 'd1'").get().calendar_id, null);
	assert.equal(sqlite.prepare("SELECT calendar_id FROM calendar_events WHERE id = 'w1'").get().calendar_id, calendar.id);
	assert.deepEqual(sqlite.prepare("SELECT id FROM calendar_shares").all().map((row) => row.id), ["csh_2"]);
});

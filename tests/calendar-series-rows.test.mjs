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
const dir = mkdtempSync(join(tmpdir(), "mailflare-series-rows-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { rows: join(root, "src/lib/calendar/series-rows.ts") }, outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") }, external: ["better-sqlite3", "pg", "postgres", "mysql2", "@neondatabase/serverless", "@planetscale/database", "@libsql/client", "@electric-sql/pglite", "bun:sqlite", "cloudflare:workers"],
});
const { deleteSeriesRows, deleteOverridesFrom, shiftOverrides, splitSeriesRows } = await import(pathToFileURL(join(dir, "rows.mjs")).href);

const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));
function setup() {
	const sqlite = new Database(":memory:");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	for (const id of ["u1", "u2"]) sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, 'U', 'x', 'user', 1)").run(id, `${id}@one.test`);
	const add = (id, user, dav = null, recurrence = null) => sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, dav_object_id, recurrence_id) VALUES (?, ?, 'E', 1000, 2000, 1, 1, ?, ?)").run(id, user, dav, recurrence);
	// A DAV resource m1 with overrides at three original instants, a native series, and another user's resource that shares nothing.
	add("m1", "u1", "m1");
	add("o1", "u1", "m1", 100); add("o2", "u1", "m1", 200); add("o3", "u1", "m1", 300);
	add("native", "u1");
	add("m2", "u2", "m2"); add("p1", "u2", "m2", 100);
	return { sqlite, orm: drizzle(sqlite), ids: () => sqlite.prepare("SELECT id FROM calendar_events ORDER BY id").all().map((r) => r.id) };
}

test("deleting a DAV master deletes its override rows, and nothing else", async () => {
	const { orm, ids } = setup();
	await deleteSeriesRows(orm, "u1", "m1");
	assert.deepEqual(ids(), ["m2", "native", "p1"]);
});

test("deleting a native event or a single override touches only that row", async () => {
	const { orm, ids } = setup();
	await deleteSeriesRows(orm, "u1", "native");
	await deleteSeriesRows(orm, "u1", "o2");
	assert.deepEqual(ids(), ["m1", "m2", "o1", "o3", "p1"]);
});

test("another user's id deletes nothing", async () => {
	const { orm, ids } = setup();
	await deleteSeriesRows(orm, "u2", "m1");
	assert.equal(ids().length, 7);
});

test("the change log sees the resource destroyed once, with no update for an override under a missing parent", async () => {
	const { orm, sqlite } = setup();
	sqlite.exec("DELETE FROM dav_changes");
	await deleteSeriesRows(orm, "u1", "m1");
	const rows = sqlite.prepare("SELECT object_key AS k, change_type AS t FROM dav_changes ORDER BY seq").all();
	assert.deepEqual(rows, [{ k: "m1", t: "destroyed" }]);
});

test("this and following removes only the overrides at or after the cut", async () => {
	const { orm, ids } = setup();
	await deleteOverridesFrom(orm, "u1", "m1", new Date(200 * 1000));
	assert.deepEqual(ids(), ["m1", "m2", "native", "o1", "p1"]);
});

test("a time-of-day shift moves each override's recurrence id", async () => {
	const { orm, sqlite } = setup();
	await shiftOverrides(orm, "u1", "m1", (at) => new Date(at.getTime() + 3_600_000));
	const rows = sqlite.prepare("SELECT id, recurrence_id AS r FROM calendar_events WHERE recurrence_id IS NOT NULL ORDER BY id").all();
	assert.deepEqual(rows, [{ id: "o1", r: 100 + 3600 }, { id: "o2", r: 200 + 3600 }, { id: "o3", r: 300 + 3600 }, { id: "p1", r: 100 }]);
});

test("splitting a DAV series at this and following ends the master, adds the new series and drops the overrides at or after the split", async () => {
	const { orm, sqlite, ids } = setup();
	const at = new Date(200 * 1000);
	const fresh = { id: "n1", userId: "u1", title: "New", startsAt: at, endsAt: new Date(300 * 1000), createdAt: new Date(1000), updatedAt: new Date(1000) };
	await splitSeriesRows(orm, "u1", { id: "m1", davObjectId: "m1" }, at, fresh, { title: "Ended", updatedAt: new Date(2000) });
	assert.deepEqual(ids(), ["m1", "m2", "n1", "native", "o1", "p1"]);
	assert.equal(sqlite.prepare("SELECT title FROM calendar_events WHERE id = 'm1'").get().title, "Ended");
});

test("splitting a native series leaves other rows alone", async () => {
	const { orm, ids } = setup();
	const fresh = { id: "n1", userId: "u1", title: "New", startsAt: new Date(2000), endsAt: new Date(3000), createdAt: new Date(1000), updatedAt: new Date(1000) };
	await splitSeriesRows(orm, "u1", { id: "native", davObjectId: null }, new Date(200 * 1000), fresh, { title: "Ended" });
	assert.equal(ids().length, 8);
});

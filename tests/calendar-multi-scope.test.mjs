import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-cal-multi-scope-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/lib/dav/changes.ts";
			export { deleteCalendar } from "./src/lib/calendar/calendars.ts";
			export { getDb } from "./src/db/index.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "cal-multi-scope-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const dav = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const { SqliteDatabase, applyMigrations, getDb } = dav;

/** The database with every executed statement recorded (text and bound values), so a test can ask SQLite for its plan. */
function recording(database) {
	const log = [];
	const wrap = (statement, sql, params = []) => {
		const note = () => log.push({ sql, params });
		return {
			bind: (...values) => wrap(statement.bind(...values), sql, values),
			run: () => (note(), statement.run()),
			all: () => (note(), statement.all()),
			raw: (options) => (note(), statement.raw(options)),
			first: (column) => (note(), statement.first(column)),
		};
	};
	const proxy = new Proxy(database, { get: (target, key) => (key === "prepare" ? (sql) => wrap(target.prepare(sql), sql) : key === "batch" ? (statements) => target.batch(statements) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
	return { proxy, log };
}

async function fixture(t, extras = 2) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	sql.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)").run();
	for (let index = 0; index < extras; index += 1) sql.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES (?, 'u1', 'calendar', 1, 1)").run(index === 0 ? "cal:work" : `cal:c${index}`);
	const { proxy, log } = recording(database);
	return { database, sql, env: { DB: proxy }, log };
}
const addEvent = (sql, id, calendarId) => sql.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', ?, 't', 1, 2, 1, 1)").run(id, calendarId);

test("the scope of the default calendar is the user's calendar collections; an extra calendar is itself", async (t) => {
	const { env } = await fixture(t);
	assert.deepEqual((await dav.calendarScopeIds(env, "cal:u1")).sort(), ["cal:c1", "cal:u1", "cal:work"]);
	assert.deepEqual(await dav.calendarScopeIds(env, "cal:work"), ["cal:work"]);
	assert.deepEqual(await dav.calendarScopeIds(env, "card:u1"), ["card:u1"]);
});

test("every change-log read of the default calendar uses an index on dav_changes", async (t) => {
	const { database, env, sql, log } = await fixture(t);
	addEvent(sql, "a", null); addEvent(sql, "b", "cal:work");
	// With table statistics (what a live database has) SQLite plans an OR over a subquery as a scan of the log.
	sql.exec("BEGIN");
	for (let index = 0; index < 3000; index += 1) sql.prepare("INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (?, ?, 'updated')").run(`cal:other${index % 40}`, `o${index}`);
	sql.exec("COMMIT; ANALYZE");
	const state = await dav.ensureSyncState(env, "cal:u1");
	log.length = 0;
	await dav.currentSeq(env, "cal:u1");
	await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, 0));
	await dav.etagSeqs(env, "cal:u1", ["a", "b"]);
	const reads = log.filter((entry) => /from "dav_changes"/i.test(entry.sql));
	assert.ok(reads.length >= 3, `expected the three reads, saw ${reads.length}`);
	for (const read of reads) {
		const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params).map((row) => row.detail).join(" | ");
		assert.doesNotMatch(plan, /SCAN dav_changes(?! USING)/, `${read.sql}\n${plan}`);
		// The sync report reads in log order, so SQLite may walk the log from the token's position; the others must use an index.
		if (!/order by/i.test(read.sql)) assert.match(plan, /dav_changes_(collection_seq|object)_idx/, plan);
	}
});

test("etagSeqs stays under 100 bound parameters per statement with 50 calendars", async (t) => {
	const { sql, env, log } = await fixture(t, 49);
	const keys = Array.from({ length: 300 }, (_, index) => `k${index}`);
	for (const key of keys.slice(0, 5)) addEvent(sql, key, "cal:work");
	log.length = 0;
	const seqs = await dav.etagSeqs(env, "cal:u1", keys);
	assert.equal(seqs.size, 5);
	assert.ok(Math.max(...log.map((entry) => entry.params.length)) <= 100, `max ${Math.max(...log.map((entry) => entry.params.length))}`);
});

test("deleting a calendar keeps its pruning floor: the default calendar's floor rises to it and the calendar's state row goes", async (t) => {
	const { sql, env } = await fixture(t);
	const state = await dav.ensureSyncState(env, "cal:u1");
	sql.prepare("UPDATE dav_sync_state SET floor = 10 WHERE collection_id = 'cal:u1'").run();
	sql.prepare("INSERT INTO dav_sync_state (collection_id, epoch, floor) VALUES ('cal:work', 'w', 50)").run();
	for (let index = 0; index < 60; index += 1) addEvent(sql, `x${index}`, null);
	assert.equal((await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, 30))), "invalid", "already below the work calendar's floor");
	sql.prepare("UPDATE dav_sync_state SET floor = 0 WHERE collection_id = 'cal:work'").run();
	const before = await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, 30));
	assert.notEqual(before, "invalid");
	sql.prepare("UPDATE dav_sync_state SET floor = 50 WHERE collection_id = 'cal:work'").run();
	sql.prepare("UPDATE dav_sync_state SET floor = 10 WHERE collection_id = 'cal:u1'").run();
	assert.equal((await dav.deleteCalendar(getDb(env), "u1", "cal:work")).ok, true);
	assert.equal(sql.prepare("SELECT floor FROM dav_sync_state WHERE collection_id = 'cal:u1'").get().floor, 50);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_sync_state WHERE collection_id = 'cal:work'").get().n, 0);
	assert.equal(await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, 30)), "invalid");
});

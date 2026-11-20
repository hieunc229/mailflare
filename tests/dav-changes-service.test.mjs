import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dav-changes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export * from "./src/lib/dav/changes.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "dav-changes-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const dav = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const { SqliteDatabase, applyMigrations } = dav;
const DAY = 86400;
const NOW = new Date("2026-11-20T00:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)").run();
	return { database, env: { DB: database }, sql: database.db };
}

const addEvent = (sql, id) => sql.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', 't', 1, 2, 1, 1)").run(id);
const age = (sql, days) => sql.prepare("UPDATE dav_changes SET created_at = ?").run(nowSec - days * DAY);

test("collection ids are derived from the user", () => {
	assert.equal(dav.calendarCollectionId("u1"), "cal:u1");
	assert.equal(dav.addressBookCollectionId("u1"), "card:u1");
});

test("a sync token round-trips and anything malformed is rejected", () => {
	const token = dav.formatSyncToken("https://mail.example.test", "cal:u1", "ep1", 42);
	assert.equal(token, "https://mail.example.test/dav/sync/cal%3Au1/ep1/42");
	assert.deepEqual(dav.parseSyncToken(token), { collectionId: "cal:u1", epoch: "ep1", seq: 42 });
	for (const bad of ["", "nope", "https://x/dav/sync/cal%3Au1/ep1", "https://x/dav/sync/cal%3Au1/ep1/-1", "https://x/dav/sync/cal%3Au1/ep1/1.5", "https://x/dav/sync/cal%3Au1/ep1/abc", "https://x/dav/other/cal%3Au1/ep1/1", "https://x/dav/sync/%E0%A4%A/ep1/1"]) {
		assert.equal(dav.parseSyncToken(bad), null, bad);
	}
});

test("the sync epoch is created once and stays", async (t) => {
	const { env } = await fixture(t);
	const first = await dav.ensureSyncState(env, "cal:u1");
	const second = await dav.ensureSyncState(env, "cal:u1");
	assert.match(first.epoch, /^[A-Za-z0-9_-]{16,}$/);
	assert.deepEqual(second, first);
	assert.equal(first.floor, 0);
	assert.notEqual((await dav.ensureSyncState(env, "cal:u2")).epoch, first.epoch);
});

test("changesSince reports the newest change per object and drops older ones", async (t) => {
	const { env, sql } = await fixture(t);
	addEvent(sql, "e1");
	addEvent(sql, "e2");
	addEvent(sql, "e3");
	const state = await dav.ensureSyncState(env, "cal:u1");
	const start = await dav.currentSeq(env, "cal:u1");
	sql.prepare("UPDATE calendar_events SET title = 'x' WHERE id = 'e1'").run();
	sql.prepare("DELETE FROM calendar_events WHERE id = 'e2'").run();
	addEvent(sql, "e4");
	sql.prepare("DELETE FROM calendar_events WHERE id = 'e4'").run();
	const token = dav.formatSyncToken("https://h", "cal:u1", state.epoch, start);
	const result = await dav.changesSince(env, "cal:u1", token);
	assert.deepEqual(result.changes.map((c) => [c.objectKey, c.type]).sort(), [["e1", "updated"], ["e2", "destroyed"], ["e4", "destroyed"]]);
	assert.equal(result.hasMore, false);
	assert.equal(result.seq, await dav.currentSeq(env, "cal:u1"));
});

test("an empty token is not a position in the log; the caller lists live resources instead", async (t) => {
	const { env } = await fixture(t);
	assert.equal(await dav.changesSince(env, "cal:u1", ""), "invalid");
});

test("a token for another collection, another epoch, or below the floor is refused", async (t) => {
	const { env, sql } = await fixture(t);
	addEvent(sql, "e1");
	const state = await dav.ensureSyncState(env, "cal:u1");
	const seq = await dav.currentSeq(env, "cal:u1");
	const url = (collection, epoch, n) => dav.formatSyncToken("https://h", collection, epoch, n);
	assert.equal(await dav.changesSince(env, "cal:u1", url("cal:u2", state.epoch, seq)), "invalid");
	assert.equal(await dav.changesSince(env, "cal:u1", url("cal:u1", "other", seq)), "invalid");
	assert.equal(await dav.changesSince(env, "cal:u1", "garbage"), "invalid");
	sql.prepare("UPDATE dav_sync_state SET floor = ? WHERE collection_id = 'cal:u1'").run(seq);
	assert.equal(await dav.changesSince(env, "cal:u1", url("cal:u1", state.epoch, seq - 1)), "invalid");
	assert.notEqual(await dav.changesSince(env, "cal:u1", url("cal:u1", state.epoch, seq)), "invalid");
});

test("a token ahead of the log is refused, so another database's tokens are not trusted", async (t) => {
	const { env, sql } = await fixture(t);
	addEvent(sql, "e1");
	const state = await dav.ensureSyncState(env, "cal:u1");
	const seq = await dav.currentSeq(env, "cal:u1");
	assert.equal(await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, seq + 5)), "invalid");
});

test("more than 500 changes come back as a first page with a continuation seq", async (t) => {
	const { env, sql } = await fixture(t);
	sql.exec("BEGIN");
	for (let i = 0; i < 520; i++) addEvent(sql, `e${i}`);
	sql.exec("COMMIT");
	const state = await dav.ensureSyncState(env, "cal:u1");
	const first = await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, 0));
	assert.equal(first.changes.length, 500);
	assert.equal(first.hasMore, true);
	const second = await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, first.seq));
	assert.equal(second.changes.length, 20);
	assert.equal(second.hasMore, false);
	assert.equal(new Set([...first.changes, ...second.changes].map((c) => c.objectKey)).size, 520);
});

test("etagSeqs gives the newest seq of each object, in chunks that stay under the bound-parameter limit", async (t) => {
	const { env, sql } = await fixture(t);
	sql.exec("BEGIN");
	for (let i = 0; i < 150; i++) addEvent(sql, `e${i}`);
	sql.exec("COMMIT");
	sql.prepare("UPDATE calendar_events SET title = 'changed' WHERE id = 'e7'").run();
	const keys = Array.from({ length: 150 }, (_, i) => `e${i}`);
	const seqs = await dav.etagSeqs(env, "cal:u1", [...keys, "missing"]);
	assert.equal(seqs.size, 150);
	assert.equal(seqs.get("e7"), sql.prepare("SELECT max(seq) AS s FROM dav_changes WHERE object_key = 'e7'").get().s);
	assert.ok(seqs.get("e7") > seqs.get("e149"));
});

test("retention drops old superseded and destroyed rows but keeps the newest live row of every object", async (t) => {
	const { env, sql } = await fixture(t);
	addEvent(sql, "keep");
	sql.prepare("UPDATE calendar_events SET title = 'a' WHERE id = 'keep'").run();
	sql.prepare("UPDATE calendar_events SET title = 'b' WHERE id = 'keep'").run();
	addEvent(sql, "gone");
	sql.prepare("DELETE FROM calendar_events WHERE id = 'gone'").run();
	age(sql, 40);
	addEvent(sql, "fresh");
	const before = sql.prepare("SELECT max(seq) AS s FROM dav_changes WHERE object_key = 'keep'").get().s;
	const gone = sql.prepare("SELECT max(seq) AS s FROM dav_changes WHERE object_key = 'gone'").get().s;
	await dav.runDavChangeRetention(env, NOW);
	const rows = sql.prepare("SELECT object_key AS k, seq FROM dav_changes ORDER BY seq").all();
	assert.deepEqual(rows.map((r) => r.k), ["keep", "fresh"]);
	assert.equal(rows[0].seq, before);
	const state = sql.prepare("SELECT floor FROM dav_sync_state WHERE collection_id = 'cal:u1'").get();
	assert.equal(state.floor, gone);
	assert.ok(sql.prepare("SELECT epoch FROM dav_sync_state WHERE collection_id = 'cal:u1'").get().epoch);
});

test("retention leaves rows younger than 30 days alone and writes no floor", async (t) => {
	const { env, sql } = await fixture(t);
	addEvent(sql, "e1");
	sql.prepare("UPDATE calendar_events SET title = 'a' WHERE id = 'e1'").run();
	age(sql, 29);
	await dav.runDavChangeRetention(env, NOW);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_changes").get().n, 2);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_sync_state").get().n, 0);
});

test("a pruned log still hands out tokens that are valid, never below the floor", async (t) => {
	const { env, sql } = await fixture(t);
	addEvent(sql, "gone");
	sql.prepare("DELETE FROM calendar_events WHERE id = 'gone'").run();
	age(sql, 40);
	await dav.runDavChangeRetention(env, NOW);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_changes").get().n, 0);
	const state = await dav.ensureSyncState(env, "cal:u1");
	const seq = await dav.currentSeq(env, "cal:u1");
	assert.equal(seq, state.floor);
	const result = await dav.changesSince(env, "cal:u1", dav.formatSyncToken("https://h", "cal:u1", state.epoch, seq));
	assert.deepEqual(result.changes, []);
});

test("a client that synced before the prune is told to resync when its token falls below the floor", async (t) => {
	const { env, sql } = await fixture(t);
	addEvent(sql, "e1");
	const state = await dav.ensureSyncState(env, "cal:u1");
	const old = dav.formatSyncToken("https://h", "cal:u1", state.epoch, 0);
	sql.prepare("UPDATE calendar_events SET title = 'a' WHERE id = 'e1'").run();
	age(sql, 40);
	addEvent(sql, "e2");
	await dav.runDavChangeRetention(env, NOW);
	assert.equal(await dav.changesSince(env, "cal:u1", old), "invalid");
});

test("one retention run prunes at most 90 rows of one collection, in at most 3 queries, and the next run continues", async (t) => {
	const { database, env, sql } = await fixture(t);
	sql.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u2', 'u2@one.test', 'U', 'x', 'user', 1)").run();
	sql.exec("BEGIN");
	for (const [collection, key] of [["cal:u1", "e1"], ["cal:u2", "e2"]])
		for (let i = 0; i < 100; i++) sql.prepare("INSERT INTO dav_changes (collection_id, object_key, change_type, created_at) VALUES (?, ?, 'updated', ?)").run(collection, key, nowSec - 40 * DAY);
	sql.exec("COMMIT");
	// The newest row of each object is kept (the objects do not exist, so only rows with a later row are prunable): 99 per collection.
	let queries = 0;
	const prepare = database.prepare.bind(database);
	database.prepare = (statement) => (queries++, prepare(statement));
	assert.equal(await dav.runDavChangeRetention(env, NOW), 90);
	assert.ok(queries <= 3, `${queries} queries`);
	database.prepare = prepare;
	const left = (collection) => sql.prepare("SELECT count(*) AS n FROM dav_changes WHERE collection_id = ?").get(collection).n;
	assert.deepEqual([left("cal:u1"), left("cal:u2")], [10, 100]);
	for (let i = 0; i < 4; i++) await dav.runDavChangeRetention(env, NOW);
	assert.deepEqual([left("cal:u1"), left("cal:u2")], [1, 1]);
});

test("retention before migration 0102 is applied does nothing instead of failing the cron", async (t) => {
	const { env, sql } = await fixture(t);
	sql.exec("DROP TABLE dav_changes");
	assert.equal(await dav.runDavChangeRetention(env, NOW), 0);
});

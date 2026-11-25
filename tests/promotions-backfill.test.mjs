import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-promotions-backfill-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		backfill: join(root, "src/lib/promotions/backfill.ts"),
		utils: join(root, "src/lib/promotions/backfill-utils.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const backfill = await load("backfill");
const utils = await load("utils");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const MINUTE = 60;
const DAY = 86_400;
const sec = () => Math.floor(Date.now() / 1000);
const MARKETING = "From: Acme <news@acme.com>\r\nList-Unsubscribe: <mailto:unsub@acme.com>\r\nSubject: Sale\r\n\r\nbody";
const PLAIN = "From: a@x.test\r\nSubject: hi\r\n\r\nbody";
const DISCUSSION = "From: list@x.test\r\nList-Id: <dev.x.test>\r\nList-Post: <mailto:dev@x.test>\r\nPrecedence: list\r\nList-Unsubscribe: <mailto:u@x.test>\r\n\r\nbody";

/** In-memory bucket with R2's `get(key, { range })`; `onGet` can throw to simulate a crash. */
function bucket(objects) {
	const calls = [];
	const stub = {
		calls,
		onGet: null,
		async get(key, options) {
			calls.push({ key, options });
			stub.onGet?.(key, calls.length);
			const text = objects.get(key);
			if (text === undefined) return null;
			const bytes = new TextEncoder().encode(text);
			const { offset = 0, length = bytes.length } = options?.range ?? {};
			return { arrayBuffer: async () => bytes.slice(offset, offset + length).buffer };
		},
	};
	return stub;
}

async function fixture(t, { mode = "show", status = "pending", updatedAt = sec(), stalls = 0, cursor = null, scanned = 0 } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u', 'o@one.test', 'O', 'x', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'u', 'one.test', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('a', 'u', 'd', 'a', 1), ('b', 'u', 'd', 'b', 1);
	`);
	database.db.prepare("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, backfill_status, backfill_stalls, backfill_cursor, backfill_scanned, updated_at) VALUES ('a', ?, ?, ?, ?, ?, ?)").run(mode, status, stalls, cursor, scanned, updatedAt);
	const objects = new Map();
	const files = bucket(objects);
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, has_unsubscribe, category, raw_r2_key, created_at) VALUES (?, 'u', ?, ?, ?, 'o@one.test', 'received', ?, ?, ?, ?)");
	let serial = 0;
	/** Newest rows get the lowest serial, so ids sort by age: m000 is the newest. */
	const add = (id, { raw = MARKETING, mailbox = "a", direction = "inbound", from = "Acme <news@acme.com>", unsub = 1, category = null, key = `raw/${id}`, age = 1 * DAY, at } = {}) => {
		if (raw !== null && key) objects.set(key, raw);
		insert.run(id, mailbox, direction, from, unsub, category, key, at ?? sec() - age - serial++);
	};
	const env = { DB: database, BUCKET: files };
	const settings = () => database.db.prepare("SELECT * FROM mailbox_promotion_settings WHERE mailbox_id = 'a'").get();
	const promoted = () => database.db.prepare("SELECT id FROM messages WHERE category = 'promotions' ORDER BY id").all().map((row) => row.id);
	const addMany = (n, options = {}) => { for (let i = 0; i < n; i++) add(`m${String(i).padStart(3, "0")}`, options); };
	return { database, env, files, objects, add, addMany, settings, promoted };
}
const at = (offsetSeconds = 0) => new Date((sec() + offsetSeconds) * 1000);

test("the constants and cursor helpers are exported for tests", () => {
	assert.equal(backfill.BACKFILL_BATCH, 25);
	assert.equal(backfill.BACKFILL_DAILY_CAP, 2000);
	assert.equal(backfill.BACKFILL_WINDOW_DAYS, 90);
	assert.equal(backfill.BACKFILL_HEAD_BYTES, 32768);
	const cursor = { createdAt: 1_700_000_000_123, id: "m1" };
	assert.deepEqual(utils.parseCursor(utils.serializeCursor(cursor)), cursor);
	for (const bad of [null, "", "nope", "{}", '{"createdAt":"x","id":1}']) assert.equal(utils.parseCursor(bad), null);
});

test("a run classifies at most 25 rows, newest first, and pages through the mailbox until a short page says done", async (t) => {
	const { env, addMany, settings, promoted, files } = await fixture(t);
	addMany(60);
	const first = await backfill.runPromotionsBackfill(env, at());
	assert.equal(first.claimed, true);
	assert.equal(promoted().length, 25);
	assert.equal(promoted()[24], "m024");
	assert.equal(files.calls.length, 25);
	assert.deepEqual(files.calls[0].options, { range: { offset: 0, length: 32768 } });
	assert.equal(settings().backfill_status, "pending");
	assert.equal(settings().backfill_scanned, 25);
	await backfill.runPromotionsBackfill(env, at(1));
	assert.equal(promoted().length, 50);
	assert.equal(settings().backfill_status, "pending");
	await backfill.runPromotionsBackfill(env, at(2));
	assert.equal(promoted().length, 60);
	assert.equal(settings().backfill_status, "done");
	assert.equal(settings().backfill_scanned, 60);
	const calls = files.calls.length;
	assert.equal((await backfill.runPromotionsBackfill(env, at(3))).claimed, false);
	assert.equal(files.calls.length, calls);
});

test("only promotions are written, with their sender address; everything else stays untouched", async (t) => {
	const { database, env, add, promoted } = await fixture(t);
	add("m001", {});
	add("m002", { raw: PLAIN, from: "a@x.test" });
	add("m003", { raw: DISCUSSION, from: "list@x.test" });
	add("m004", { from: "Mixed Case <NEWS@Acme.com>" });
	await backfill.runPromotionsBackfill(env, at());
	assert.deepEqual(promoted(), ["m001", "m004"]);
	assert.deepEqual(database.db.prepare("SELECT id, sender_address FROM messages WHERE category = 'promotions' ORDER BY id").all(), [{ id: "m001", sender_address: "news@acme.com" }, { id: "m004", sender_address: "news@acme.com" }]);
	assert.deepEqual(database.db.prepare("SELECT id, category, sender_address FROM messages WHERE category IS NULL ORDER BY id").all(), [{ id: "m002", category: null, sender_address: null }, { id: "m003", category: null, sender_address: null }]);
});

test("rows that are not candidates are never read or written: primary, already filed, outbound, no unsubscribe, too old, no raw object, other mailbox", async (t) => {
	const { database, env, add, files, settings } = await fixture(t);
	add("primary", { category: "primary" });
	add("already", { category: "promotions" });
	add("sent", { direction: "outbound" });
	add("no-unsub", { unsub: 0 });
	add("old", { age: 91 * DAY });
	add("no-raw", { raw: null, key: null });
	add("other-box", { mailbox: "b" });
	add("candidate", {});
	await backfill.runPromotionsBackfill(env, at());
	assert.deepEqual(files.calls.map((call) => call.key), ["raw/candidate"]);
	assert.deepEqual(database.db.prepare("SELECT id, category FROM messages WHERE category IS NOT NULL ORDER BY id").all().map((row) => [row.id, row.category]), [["already", "promotions"], ["candidate", "promotions"], ["primary", "primary"]]);
	assert.equal(settings().backfill_status, "done");
});

test("the daily cap: a run reads only what is left of 2,000 rows, then waits for the next UTC day", async (t) => {
	const { database, env, addMany, files, settings, promoted } = await fixture(t);
	addMany(60);
	const day = Math.floor(at().getTime() / 86_400_000);
	database.db.prepare("UPDATE mailbox_promotion_settings SET backfill_day = ?, backfill_day_rows = 1990").run(day);
	const first = await backfill.runPromotionsBackfill(env, at());
	assert.equal(first.scanned, 10);
	assert.equal(files.calls.length, 10);
	assert.equal(settings().backfill_day_rows, 2000);
	assert.equal(settings().backfill_status, "pending", "a short read caused by the cap is not the end of the mailbox");
	assert.equal((await backfill.runPromotionsBackfill(env, at(1))).claimed, false);
	assert.equal(files.calls.length, 10);
	assert.equal(promoted().length, 10);
	// The next UTC day starts a fresh count.
	const tomorrow = new Date((day + 1) * 86_400_000 + 1000);
	assert.equal((await backfill.runPromotionsBackfill(env, tomorrow)).scanned, 25);
	assert.equal(settings().backfill_day, day + 1);
	assert.equal(settings().backfill_day_rows, 25);
});

test("the daily cap is per installation: rows another mailbox backfilled today count against this one", async (t) => {
	const { database, env, addMany, files } = await fixture(t);
	addMany(60);
	const day = Math.floor(at().getTime() / 86_400_000);
	database.db.prepare("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, backfill_status, backfill_day, backfill_day_rows, updated_at) VALUES ('b', 'show', 'done', ?, 1995, 1)").run(day);
	await backfill.runPromotionsBackfill(env, at());
	assert.equal(files.calls.length, 5);
	// Yesterday's count of the other mailbox no longer counts.
	database.db.prepare("UPDATE mailbox_promotion_settings SET backfill_day = ? WHERE mailbox_id = 'b'").run(day - 1);
	assert.equal((await backfill.runPromotionsBackfill(env, at(1))).scanned, 25);
});

test("overlapping runs claim the job once", async (t) => {
	const { env, addMany, files, promoted } = await fixture(t);
	addMany(20);
	const results = await Promise.all([backfill.runPromotionsBackfill(env, at()), backfill.runPromotionsBackfill(env, at()), backfill.runPromotionsBackfill(env, at())]);
	assert.equal(results.filter((result) => result.claimed).length, 1);
	assert.equal(files.calls.length, 20);
	assert.equal(promoted().length, 20);
});

test("claims: off, failed, done, idle and fresh running rows are not taken; a running row is taken over only after 15 minutes", async (t) => {
	const { env, addMany, settings, database } = await fixture(t, { mode: "off", status: "pending" });
	addMany(3);
	assert.equal((await backfill.runPromotionsBackfill(env, at())).claimed, false);
	for (const status of ["failed", "done", "idle"]) {
		database.db.exec(`UPDATE mailbox_promotion_settings SET mode = 'show', backfill_status = '${status}'`);
		assert.equal((await backfill.runPromotionsBackfill(env, at())).claimed, false, status);
	}
	database.db.prepare("UPDATE mailbox_promotion_settings SET backfill_status = 'running', updated_at = ?").run(sec() - 14 * MINUTE);
	assert.equal((await backfill.runPromotionsBackfill(env, at())).claimed, false);
	assert.equal(settings().backfill_status, "running");
	database.db.prepare("UPDATE mailbox_promotion_settings SET updated_at = ?").run(sec() - 16 * MINUTE);
	assert.equal((await backfill.runPromotionsBackfill(env, at())).claimed, true);
	assert.equal(settings().backfill_status, "done");
});

test("a missing raw object is skipped without stopping the run", async (t) => {
	const { env, add, objects, promoted, settings } = await fixture(t);
	add("m001", {});
	add("m002", {});
	add("m003", {});
	objects.delete("raw/m002");
	await backfill.runPromotionsBackfill(env, at());
	assert.deepEqual(promoted(), ["m001", "m003"]);
	assert.equal(settings().backfill_scanned, 3);
	assert.equal(settings().backfill_status, "done");
});

test("the cursor and scanned count are saved after every chunk of 10: a crash in the second chunk keeps the first", async (t) => {
	const { database, env, files, addMany, settings, promoted } = await fixture(t);
	addMany(25);
	files.onGet = (key, n) => { if (n === 11) throw new Error("worker killed"); };
	await assert.rejects(backfill.runPromotionsBackfill(env, at()), /worker killed/);
	assert.equal(settings().backfill_scanned, 10);
	assert.equal(settings().backfill_status, "running");
	assert.equal(settings().backfill_stalls, 0, "a saved chunk is progress");
	assert.equal(promoted().length, 10);
	const cursor = utils.parseCursor(settings().backfill_cursor);
	assert.equal(cursor.id, "m009");
	assert.equal(cursor.createdAt, database.db.prepare("SELECT created_at * 1000 AS c FROM messages WHERE id = 'm009'").get().c);
	// 16 minutes later the next run resumes after the cursor and never re-reads the first chunk.
	files.onGet = null;
	files.calls.length = 0;
	await backfill.runPromotionsBackfill(env, at(16 * MINUTE));
	assert.equal(files.calls.length, 15);
	assert.equal(promoted().length, 25);
	assert.equal(settings().backfill_status, "done");
	assert.equal(settings().backfill_scanned, 25);
});

test("rows sharing one created_at are neither skipped nor read twice across chunks", async (t) => {
	const { env, add, files, promoted } = await fixture(t);
	const same = sec() - DAY;
	for (let i = 0; i < 23; i++) add(`m${String(i).padStart(3, "0")}`, { at: same });
	await backfill.runPromotionsBackfill(env, at());
	assert.equal(promoted().length, 23);
	assert.equal(new Set(files.calls.map((call) => call.key)).size, 23);
});

test("three consecutive takeovers without progress mark the job failed with an error, and failed jobs are not claimed again", async (t) => {
	const { env, files, addMany, settings } = await fixture(t);
	addMany(5);
	files.onGet = () => { throw new Error("bucket down"); };
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args.join(" "));
	t.after(() => { console.error = original; });
	await assert.rejects(backfill.runPromotionsBackfill(env, at()));
	assert.equal(settings().backfill_status, "running");
	await assert.rejects(backfill.runPromotionsBackfill(env, at(16 * MINUTE)));
	await assert.rejects(backfill.runPromotionsBackfill(env, at(32 * MINUTE)));
	assert.equal(settings().backfill_status, "running");
	assert.equal(settings().backfill_stalls, 3);
	const result = await backfill.runPromotionsBackfill(env, at(48 * MINUTE));
	assert.equal(result.claimed, false);
	assert.equal(settings().backfill_status, "failed");
	assert.match(settings().backfill_error, /no progress/i);
	assert.ok(errors.some((line) => /backfill/i.test(line) && /failed/i.test(line)), errors.join("\n"));
	files.onGet = null;
	assert.equal((await backfill.runPromotionsBackfill(env, at(64 * MINUTE))).claimed, false);
});

test("progress resets the stall count, so a slow but advancing job is never failed", async (t) => {
	const { env, files, addMany, settings } = await fixture(t, { status: "running", updatedAt: sec() - 20 * MINUTE, stalls: 2 });
	addMany(25);
	files.onGet = (key, n) => { if (n === 11) throw new Error("killed"); };
	await assert.rejects(backfill.runPromotionsBackfill(env, at()));
	assert.equal(settings().backfill_stalls, 0);
	files.onGet = (key, n) => { if (n === 22) throw new Error("killed again"); };
	await assert.rejects(backfill.runPromotionsBackfill(env, at(16 * MINUTE)));
	assert.equal(settings().backfill_status, "running");
	assert.equal(settings().backfill_stalls, 0);
	assert.equal(settings().backfill_scanned, 20);
});

test("switching the mode to off mid-run stops the job before anything is written", async (t) => {
	const { database, env, files, addMany, settings, promoted } = await fixture(t);
	addMany(25);
	files.onGet = (key, n) => { if (n === 1) database.db.exec("UPDATE mailbox_promotion_settings SET mode = 'off'"); };
	const result = await backfill.runPromotionsBackfill(env, at());
	assert.equal(result.claimed, true);
	assert.equal(promoted().length, 0);
	assert.equal(settings().backfill_scanned, 0);
	assert.equal(settings().backfill_status, "running");
	// Turned on again later, it resumes where it was once the row is stale.
	files.onGet = null;
	database.db.exec("UPDATE mailbox_promotion_settings SET mode = 'show'");
	await backfill.runPromotionsBackfill(env, at(16 * MINUTE));
	assert.equal(promoted().length, 25);
});

test("a user's override and contact decide like at intake: always-Inbox and correspondents stay out", async (t) => {
	const { database, env, add, promoted } = await fixture(t);
	add("m001", {});
	add("m002", { from: "Friend <friend@x.test>" });
	add("m003", { from: "Pinned <pin@x.test>", raw: PLAIN });
	add("m004", { from: "Skipped <skip@x.test>" });
	database.db.exec(`
		INSERT INTO contacts (id, user_id, email, source, created_at) VALUES ('c1', 'u', 'friend@x.test', 'manual', 1);
		INSERT INTO mailbox_sender_preferences (id, mailbox_id, sender_address, category_override, updated_at) VALUES ('p1', 'a', 'pin@x.test', 'promotions', 1), ('p2', 'a', 'skip@x.test', 'inbox', 1);
	`);
	await backfill.runPromotionsBackfill(env, at());
	assert.deepEqual(promoted(), ["m001", "m003"]);
});

test("a message moved to Inbox while the run reads it is not overwritten", async (t) => {
	const { database, env, add, files, promoted } = await fixture(t);
	add("m001", {});
	add("m002", {});
	files.onGet = (key, n) => { if (n === 2) database.db.exec("UPDATE messages SET category = 'primary' WHERE id = 'm001'"); };
	await backfill.runPromotionsBackfill(env, at());
	assert.deepEqual(promoted(), ["m002"]);
	assert.equal(database.db.prepare("SELECT category FROM messages WHERE id = 'm001'").get().category, "primary");
});

test("before the migration the run does nothing and does not throw", async (t) => {
	const { database, env } = await fixture(t);
	database.db.exec("DROP TABLE mailbox_promotion_settings");
	assert.equal((await backfill.runPromotionsBackfill(env, at())).claimed, false);
});

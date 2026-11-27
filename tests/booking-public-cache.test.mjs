import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, mock } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-8: the public slot list is the one expensive public read, so it is kept for a short while in the Workers cache (keyed by event type and day).
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "booking-public-cache", entryPoint: "src/app/api/public/booking/[eventId]/route.ts", mocks: {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.pubc.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:true}}",
	"@/lib/auth/rate-limit": "export async function allowBookingAttempt(){return true}",
	"@/lib/booking/confirmation": "export async function sendBookingConfirmation(){}",
} });
const { GET, POST } = await fixture.import();
let sqlite;
let queries = 0;
const stored = new Map();
after(() => { sqlite?.close(); delete globalThis.pubc; delete globalThis.caches; fixture.dispose(); mock.timers.reset(); });

const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7);
function setup({ withCache = true } = {}) {
	sqlite?.close();
	stored.clear();
	queries = 0;
	sqlite = installSqlite("pubc", { schema, beforeQuery: (sql) => { if (/calendar_events/.test(sql) && /select/i.test(sql)) queries += 1; } });
	const db = globalThis.pubc.db;
	const run = db.run.bind(db);
	db.run = async (query) => { await run(query); return { meta: { changes: Number(sqlite.prepare("select changes() as c").get().c) } }; };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at, time_zone, booking_username) VALUES ('h1', 'h1@one.test', 'Hana', 'x', 'user', 1, 'UTC', 'hana')");
	sqlite.exec(`INSERT INTO booking_events (id, user_id, name, slug, host_ids, duration_minutes, weekdays, time_ranges, time_zone, enabled, created_at, updated_at) VALUES ('book_1', 'h1', 'Intro', 'intro', '["h1"]', 30, '[1,2,3,4,5]', '[{"startTime":"09:00","endTime":"11:00"}]', 'UTC', 1, 1, 1)`);
	sqlite.exec(`INSERT INTO booking_events (id, user_id, name, slug, host_ids, duration_minutes, weekdays, time_ranges, time_zone, enabled, created_at, updated_at) VALUES ('book_2', 'h1', 'Other', 'other', '["h1"]', 30, '[1,2,3,4,5]', '[{"startTime":"09:00","endTime":"11:00"}]', 'UTC', 1, 1, 1)`);
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: T0 });
	if (withCache) globalThis.caches = { default: { match: async (request) => stored.get(request.url)?.clone(), put: async (request, response) => { stored.set(request.url, response); } } };
	else delete globalThis.caches;
}
const get = (id = "book_1") => GET(new Request(`http://x/api/public/booking/${id}`), { params: Promise.resolve({ eventId: id }) });

test("a second read within the time is served from the cache without reading the calendar again", async () => {
	setup();
	const first = await (await get()).json();
	const reads = queries;
	assert.ok(reads > 0);
	const second = await (await get()).json();
	assert.equal(queries, reads, "no further calendar reads");
	assert.deepEqual(second.slots, first.slots);
	assert.deepEqual(second.event, first.event);
});

test("the cached copy lives for 30 to 60 seconds and is keyed by event type and day", async () => {
	setup();
	await get("book_1");
	await get("book_2");
	const keys = [...stored.keys()];
	assert.equal(keys.length, 2);
	assert.notEqual(keys[0], keys[1]);
	assert.match(keys[0], /book_1/);
	assert.match(keys[0], /2030-01-07/);
	const maxAge = Number(/max-age=(\d+)/.exec(stored.get(keys[0]).headers.get("Cache-Control"))[1]);
	assert.ok(maxAge >= 30 && maxAge <= 60);
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date"], now: T0 + 24 * H });
	const before = stored.size;
	await get("book_1");
	assert.equal(stored.size, before + 1, "the next day is a new entry");
});

test("a type that does not exist, or is switched off, is answered live and never cached", async () => {
	setup();
	assert.equal((await get("ghost")).status, 404);
	sqlite.exec("UPDATE booking_events SET enabled = 0 WHERE id = 'book_1'");
	assert.equal((await get("book_1")).status, 404);
	assert.equal(stored.size, 0);
});

test("without the Workers cache (Node) it simply answers", async () => {
	setup({ withCache: false });
	assert.equal((await get()).status, 200);
	setup();
	globalThis.caches = {};
	assert.equal((await get()).status, 200);
});

test("a cache that fails never fails the page", async () => {
	setup();
	globalThis.caches = { default: { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } } };
	assert.equal((await get()).status, 200);
});

test("a booking is never decided from the cache: the POST reads the calendar live", async () => {
	setup();
	await get();
	const reads = queries;
	await POST(new Request("http://x/api/public/booking/book_1", { method: "POST", body: JSON.stringify({ name: "G", email: "g@x.test", startsAt: new Date(T0 + 9 * H).toISOString() }) }), { params: Promise.resolve({ eventId: "book_1" }) });
	assert.ok(queries > reads);
});

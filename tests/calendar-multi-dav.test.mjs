import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-cal-multi-dav-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest } from "./src/lib/dav/handler.ts";
			export { clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { deleteCalendar, createCalendar } from "./src/lib/calendar/calendars.ts";
			export { getDb } from "./src/db/index.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "cal-multi-dav-entry.ts",
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
const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, deleteCalendar, getDb, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";
const CAL = "/dav/calendars/u1/default/";

async function fixture(t) {
	clearApiKeyVerificationCache();
	clearDavEnabledCache();
	const database = new SqliteDatabase(":memory:");
	t.after(() => { database.db.close(); clearApiKeyVerificationCache(); clearDavEnabledCache(); });
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	sql.prepare("INSERT INTO users (id, email, name, password_hash, role, calendar_enabled, time_zone, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1, 'Europe/Berlin', 1)").run();
	sql.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	const key = await generateAppPassword();
	sql.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k1', 'u1', 'phone', ?, ?, ?, 'app', '[\"dav\"]', 1)").run(key.prefix, key.hash, key.sha256);
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 1, 1)").run();
	return { sql, key, env: { DB: database } };
}

const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const call = (env, method, path, { key, body, headers = {} } = {}) => handleDavRequest(new Request(`${ORIGIN}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const report = (env, key, body) => call(env, "REPORT", CAL, { key, body: `<?xml version="1.0"?>${body}`, headers: { Depth: "0", "Content-Type": "application/xml" } });
const NS = `xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;
const syncSince = (env, key, token) => report(env, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`);
const tokenOf = (text) => text.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
const hrefs = (text) => [...text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const ctag = async (env, key) => { const text = await (await call(env, "PROPFIND", CAL, { key, headers: { Depth: "0", "Content-Type": "application/xml" }, body: '<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:CS="http://calendarserver.org/ns/"><A:prop><CS:getctag/></A:prop></A:propfind>' })).text(); const found = text.match(/getctag>([^<]*)</)?.[1]; assert.ok(found, text); return found; };
const ics = (title) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 26//EN\r\nBEGIN:VEVENT\r\nUID:uid-1\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const addEvent = (sql, id, calendarId) => sql.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', ?, 'Work thing', 1793000000, 1793003600, 1, 1)").run(id, calendarId);

test("an event created in another calendar moves default/'s CTag and sync-collection reports it", async (t) => {
	const { env, key, sql } = await fixture(t);
	const first = await syncSince(env, key, "");
	const token = tokenOf(await first.text());
	const before = await ctag(env, key);
	addEvent(sql, "evt_work", "cal:work");
	assert.notEqual(await ctag(env, key), before);
	const next = await (await syncSince(env, key, token)).text();
	assert.equal(next.includes("evt_work") || hrefs(next).some((href) => href.startsWith(CAL)), true, next);
	assert.equal(hrefs(next).filter((href) => href.startsWith(CAL)).length, 1);
});

test("deleting the calendar reports its events destroyed to the phone", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, "evt_work", "cal:work");
	const token = tokenOf(await (await syncSince(env, key, "")).text());
	await deleteCalendar(getDb(env), "u1", "cal:work");
	const next = await (await syncSince(env, key, token)).text();
	assert.match(next, /404 Not Found/, next);
	assert.equal(hrefs(next).filter((href) => href.startsWith(CAL)).length, 1);
});

test("a web edit of an event in another calendar makes a phone's PUT with the old ETag 412", async (t) => {
	const { env, key, sql } = await fixture(t);
	const created = await call(env, "PUT", `${CAL}e.ics`, { key, body: ics("One"), headers: { "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" } });
	assert.equal(created.status, 201);
	const id = sql.prepare("SELECT id FROM dav_calendar_objects WHERE name = 'e.ics'").get().id;
	sql.prepare("UPDATE calendar_events SET calendar_id = 'cal:work' WHERE id = ?").run(id);
	const etag = (await call(env, "GET", `${CAL}e.ics`, { key })).headers.get("ETag");
	sql.prepare("UPDATE calendar_events SET title = 'Edited on the web', updated_at = updated_at + 1 WHERE id = ?").run(id);
	const changed = (await call(env, "GET", `${CAL}e.ics`, { key })).headers.get("ETag");
	assert.notEqual(changed, etag, "the web edit moves the ETag a phone sees");
	const stale = await call(env, "PUT", `${CAL}e.ics`, { key, body: ics("Phone"), headers: { "Content-Type": "text/calendar; charset=utf-8", "If-Match": etag } });
	assert.equal(stale.status, 412);
	assert.equal(sql.prepare("SELECT title FROM calendar_events WHERE id = ?").get(id).title, "Edited on the web");
});

const series = (title) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 26//EN\r\nBEGIN:VEVENT\r\nUID:uid-s\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:uid-s\r\nDTSTAMP:20261101T000000Z\r\nRECURRENCE-ID:20261109T090000Z\r\nDTSTART:20261109T100000Z\r\nDTEND:20261109T110000Z\r\nSUMMARY:${title} moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test("a phone replacing a series that lives in another calendar keeps its override rows in that calendar", async (t) => {
	const { env, key, sql } = await fixture(t);
	const headers = { "Content-Type": "text/calendar; charset=utf-8" };
	assert.equal((await call(env, "PUT", `${CAL}s.ics`, { key, body: series("One"), headers: { ...headers, "If-None-Match": "*" } })).status, 201);
	const id = sql.prepare("SELECT id FROM dav_calendar_objects WHERE name = 's.ics'").get().id;
	sql.prepare("UPDATE calendar_events SET calendar_id = 'cal:work' WHERE id = ? OR dav_object_id = ?").run(id, id);
	const etag = (await call(env, "GET", `${CAL}s.ics`, { key })).headers.get("ETag");
	assert.equal((await call(env, "PUT", `${CAL}s.ics`, { key, body: series("Two"), headers: { ...headers, "If-Match": etag } })).status, 204);
	const rows = sql.prepare("SELECT title, calendar_id FROM calendar_events WHERE dav_object_id = ? ORDER BY recurrence_id IS NOT NULL").all(id);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map((row) => row.calendar_id), ["cal:work", "cal:work"]);
});

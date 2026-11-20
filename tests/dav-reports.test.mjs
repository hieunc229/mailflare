import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dav-reports-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest } from "./src/lib/dav/handler.ts";
			export { clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "dav-reports-entry.ts",
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

const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";
const CAL = "/dav/calendars/u1/default/";
const BOOK = "/dav/addressbooks/u1/default/";
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

/** The database wrapped so a test can count statements and the most bound parameters one statement carried. */
function counting(database) {
	const stats = { queries: 0, maxParams: 0, maxRows: 0 };
	const wrap = (statement, params = 0) => {
		const note = (result) => (Promise.resolve(result).then((rows) => void (stats.maxRows = Math.max(stats.maxRows, Array.isArray(rows) ? rows.length : Array.isArray(rows?.results) ? rows.results.length : 0))), result);
		const count = () => (stats.queries++, (stats.maxParams = Math.max(stats.maxParams, params)));
		return {
			bind: (...values) => wrap(statement.bind(...values), values.length),
			run: () => (count(), statement.run()),
			all: () => (count(), note(statement.all())),
			raw: (options) => (count(), note(statement.raw(options))),
			first: (column) => (count(), statement.first(column)),
		};
	};
	const proxy = new Proxy(database, { get: (target, key) => (key === "prepare" ? (sql) => wrap(target.prepare(sql)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
	return { proxy, stats };
}

async function fixture(t, { calendarEnabled = true } = {}) {
	clearApiKeyVerificationCache();
	clearDavEnabledCache();
	const database = new SqliteDatabase(":memory:");
	t.after(() => {
		database.db.close();
		clearApiKeyVerificationCache();
		clearDavEnabledCache();
	});
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const insertUser = sql.prepare("INSERT INTO users (id, email, name, password_hash, role, calendar_enabled, time_zone, created_at) VALUES (?, ?, ?, 'x', 'user', ?, ?, 1)");
	insertUser.run("u1", "u1@one.test", "User One", calendarEnabled ? 1 : 0, "Europe/Berlin");
	insertUser.run("u2", "u2@one.test", "User Two", 1, null);
	sql.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	const key = await generateAppPassword();
	sql.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k1', 'u1', 'phone', ?, ?, ?, 'app', '[\"dav\"]', 1)").run(key.prefix, key.hash, key.sha256);
	const { proxy, stats } = counting(database);
	return { database, sql, key, stats, env: { DB: proxy } };
}

const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const call = (env, method, path, { key, body, headers = {} } = {}) => handleDavRequest(new Request(`${ORIGIN}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const xml = { "Content-Type": "application/xml" };
const propfind = (env, path, key, props, depth = "0") => call(env, "PROPFIND", path, { key, body: `<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:R="urn:ietf:params:xml:ns:carddav" xmlns:S="http://calendarserver.org/ns/"><A:prop>${props}</A:prop></A:propfind>`, headers: { Depth: depth, ...xml } });
const report = (env, path, key, body, depth = "1") => call(env, "REPORT", path, { key, body: `<?xml version="1.0"?>${body}`, headers: { Depth: depth, ...xml } });
const NS = `xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:R="urn:ietf:params:xml:ns:carddav"`;

let counter = 0;
function addEvent(sql, fields = {}) {
	const row = { id: `evt${++counter}`, user_id: "u1", title: "Event", description: "", location: "", starts_at: sec("2026-11-02T17:00:00Z"), ends_at: sec("2026-11-02T18:00:00Z"), repeat: "none", repeat_days: "[]", excluded_occurrences: "[]", time_zone: null, response_status: null, rrule: null, recurrence_id: null, dav_object_id: null, all_day: 0, created_at: 1, updated_at: sec("2026-11-01T00:00:00Z"), ...fields };
	const names = Object.keys(row);
	sql.prepare(`INSERT INTO calendar_events (${names.join(", ")}) VALUES (${names.map((n) => `@${n}`).join(", ")})`).run(row);
	return row.id;
}
let cards = 0;
function addCard(sql, fields = {}) {
	const n = ++cards;
	const body = fields.body ?? `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:card-${n}\r\nFN:${fields.fn ?? `Person ${n}`}\r\nEND:VCARD\r\n`;
	const row = { id: `card${n}`, user_id: "u1", collection_id: "card:u1", name: `card${n}.vcf`, uid: `card-${n}`, body, version: "3.0", fn: `Person ${n}`, emails: "[]", size: body.length, created_at: 1, updated_at: 5, ...fields };
	const names = Object.keys(row);
	sql.prepare(`INSERT INTO dav_cards (${names.join(", ")}) VALUES (${names.map((n) => `@${n}`).join(", ")})`).run(row);
	return row.id;
}
const hrefs = (text) => [...text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const etagOf = (text, name) => text.match(new RegExp(`${name}</D:href><D:propstat><D:prop><D:getetag>&quot;(\\w+)&quot;`))?.[1];

test("the calendar home lists the one calendar at depth 1 and none at depth 0", async (t) => {
	const { env, key } = await fixture(t);
	const one = hrefs(await (await propfind(env, "/dav/calendars/u1/", key, "<A:resourcetype/>", "1")).text());
	assert.deepEqual(one, ["/dav/calendars/u1/", CAL]);
	assert.deepEqual(hrefs(await (await propfind(env, "/dav/calendars/u1/", key, "<A:resourcetype/>", "0")).text()), ["/dav/calendars/u1/"]);
	assert.deepEqual(hrefs(await (await propfind(env, "/dav/addressbooks/u1/", key, "<A:resourcetype/>", "1")).text()), ["/dav/addressbooks/u1/", BOOK]);
});

test("the calendar collection carries the properties clients ask for", async (t) => {
	const { env, key } = await fixture(t);
	const names = "<A:resourcetype/><A:displayname/><C:supported-calendar-component-set/><C:supported-calendar-data/><C:max-resource-size/><C:min-date-time/><C:max-date-time/><C:max-instances/><C:max-attendees-per-instance/><C:calendar-timezone/><S:getctag/><A:sync-token/><A:supported-report-set/><A:current-user-privilege-set/><A:owner/>";
	const response = await propfind(env, CAL, key, names);
	assert.equal(response.status, 207);
	const text = await response.text();
	assert.match(text, /<D:resourcetype><D:collection\/><C:calendar\/><\/D:resourcetype>/);
	assert.match(text, /<D:displayname>Mailflare<\/D:displayname>/);
	assert.match(text, /<C:supported-calendar-component-set><C:comp name="VEVENT"\/><\/C:supported-calendar-component-set>/);
	assert.match(text, /<C:max-resource-size>1048576<\/C:max-resource-size>/);
	assert.match(text, /<C:min-date-time>19000101T000000Z<\/C:min-date-time><C:max-date-time>22000101T000000Z<\/C:max-date-time>/);
	assert.match(text, /<C:calendar-timezone>BEGIN:VCALENDAR[\s\S]*TZID:Europe\/Berlin[\s\S]*END:VCALENDAR\r\n<\/C:calendar-timezone>/);
	const token = text.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
	assert.match(token, /^https:\/\/mail\.example\.test\/dav\/sync\/cal%3Au1\/[0-9a-f-]{36}\/0$/);
	assert.match(text, new RegExp(`<CS:getctag>${token.replace(/[/.]/g, "\\$&")}</CS:getctag>`));
	for (const report of ["calendar-multiget", "calendar-query", "sync-collection"]) assert.match(text, new RegExp(`<D:report><[A-Z]+:${report}/></D:report>`));
	// Read-only until the write methods exist: no write privileges are claimed.
	assert.match(text, /<D:privilege><D:read\/><\/D:privilege><D:privilege><D:read-current-user-privilege-set\/><\/D:privilege>/);
	assert.doesNotMatch(text, /write|bind/);
	assert.match(text, /<D:owner><D:href>\/dav\/principals\/u1\/<\/D:href><\/D:owner>/);
});

test("depth 1 lists visible events with ETags; needs-action, declined, cancelled and other users' events are left out", async (t) => {
	const { env, key, sql } = await fixture(t);
	const a = addEvent(sql, { id: "a" });
	addEvent(sql, { id: "pending", response_status: "needs-action" });
	addEvent(sql, { id: "declined", response_status: "declined" });
	addEvent(sql, { id: "cancelled", response_status: "cancelled" });
	addEvent(sql, { id: "tentative", response_status: "tentative" });
	addEvent(sql, { id: "theirs", user_id: "u2" });
	const text = await (await propfind(env, CAL, key, "<A:getetag/><A:getcontenttype/><A:resourcetype/><A:getlastmodified/>", "1")).text();
	assert.deepEqual(hrefs(text).slice(1), [`${CAL}${a}.ics`, `${CAL}tentative.ics`]);
	assert.match(text, /<D:getcontenttype>text\/calendar; charset=utf-8<\/D:getcontenttype>/);
	assert.match(text, /<D:getlastmodified>Sun, 01 Nov 2026 00:00:00 GMT<\/D:getlastmodified>/);
	assert.match(etagOf(text, `${a}.ics`) ?? "", /^\d+$/);
});

test("GET serves the event with its ETag; If-None-Match gives 304 and HEAD has no body", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1", title: "Standup, daily", location: "Room 1" });
	const response = await call(env, "GET", `${CAL}e1.ics`, { key });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Content-Type"), "text/calendar; charset=utf-8");
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const etag = response.headers.get("ETag");
	assert.match(etag, /^"\d+"$/);
	const body = await response.text();
	assert.match(body, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/Mailflare\/\/Calendar\/\/EN\r\n/);
	assert.match(body, /UID:e1@mailflare\r\n/);
	assert.match(body, /DTSTART:20261102T170000Z\r\n/);
	assert.match(body, /SUMMARY:Standup\\, daily\r\n/);
	assert.ok(!body.includes("METHOD:"));
	assert.equal(response.headers.get("Content-Length"), String(Buffer.byteLength(body)));
	// The PROPFIND ETag is the GET ETag.
	assert.equal(etagOf(await (await propfind(env, CAL, key, "<A:getetag/>", "1")).text(), "e1.ics"), etag.slice(1, -1));

	const cached = await call(env, "GET", `${CAL}e1.ics`, { key, headers: { "If-None-Match": etag } });
	assert.equal(cached.status, 304);
	assert.equal(await cached.text(), "");
	assert.equal((await call(env, "GET", `${CAL}e1.ics`, { key, headers: { "If-None-Match": '"zzz"' } })).status, 200);
	assert.equal((await call(env, "GET", `${CAL}e1.ics`, { key, headers: { "If-None-Match": "*" } })).status, 304);
	assert.equal((await call(env, "GET", `${CAL}e1.ics`, { key, headers: { "If-Match": '"zzz"' } })).status, 412);
	const head = await call(env, "HEAD", `${CAL}e1.ics`, { key });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	assert.equal(head.headers.get("ETag"), etag);
});

test("a Mailflare-side edit changes the ETag; a reminder bookkeeping update does not", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1" });
	const first = (await call(env, "GET", `${CAL}e1.ics`, { key })).headers.get("ETag");
	sql.prepare("UPDATE calendar_events SET last_reminded_start = 99 WHERE id = 'e1'").run();
	assert.equal((await call(env, "GET", `${CAL}e1.ics`, { key })).headers.get("ETag"), first);
	sql.prepare("UPDATE calendar_events SET title = 'Renamed', updated_at = updated_at + 1 WHERE id = 'e1'").run();
	const second = await call(env, "GET", `${CAL}e1.ics`, { key });
	assert.notEqual(second.headers.get("ETag"), first);
	assert.match(await second.text(), /SUMMARY:Renamed/);
});

test("hidden, foreign, unknown and badly named resources", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "pending", response_status: "needs-action" });
	addEvent(sql, { id: "theirs", user_id: "u2" });
	for (const name of ["pending.ics", "theirs.ics", "nothing.ics"]) assert.equal((await call(env, "GET", `${CAL}${name}`, { key })).status, 404, name);
	assert.equal((await propfind(env, `${CAL}theirs.ics`, key, "<A:getetag/>")).status, 404);
	for (const name of ["a.txt", "a%2Fb.ics", "..%2Fx.ics", "a b.ics", `${"x".repeat(201)}.ics`, "a.vcf"]) assert.equal((await call(env, "GET", `${CAL}${name}`, { key })).status, 400, name);
	assert.equal((await call(env, "GET", `${CAL}`, { key })).status, 405);
	assert.equal((await call(env, "GET", "/dav/calendars/u1/other/", { key })).status, 404);
	assert.equal((await call(env, "GET", "/dav/calendars/u2/default/theirs.ics", { key })).status, 404);
	assert.equal((await call(env, "GET", `${CAL}a.ics`)).status, 401);
});

test("a recurring event is written in its zone with a VTIMEZONE, RRULE and EXDATE", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "r1", repeat: "weekly", time_zone: "America/Los_Angeles", starts_at: sec("2026-11-02T17:00:00Z"), ends_at: sec("2026-11-02T18:00:00Z"), excluded_occurrences: JSON.stringify([Date.parse("2026-11-09T17:00:00Z")]) });
	const body = await (await call(env, "GET", `${CAL}r1.ics`, { key })).text();
	assert.match(body, /BEGIN:VTIMEZONE\r\nTZID:America\/Los_Angeles\r\n/);
	assert.match(body, /END:VTIMEZONE\r\nBEGIN:VEVENT\r\n/);
	assert.match(body, /DTSTART;TZID=America\/Los_Angeles:20261102T090000\r\n/);
	assert.match(body, /RRULE:FREQ=WEEKLY\r\n/);
	assert.match(body, /EXDATE;TZID=America\/Los_Angeles:20261109T090000\r\n/);
});

test("a DAV series is served under its stored name and UID with its override rows", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "m1", dav_object_id: "m1", repeat: "custom", rrule: "FREQ=WEEKLY;INTERVAL=2", time_zone: "Europe/Berlin", starts_at: sec("2026-11-02T09:00:00Z"), ends_at: sec("2026-11-02T10:00:00Z"), excluded_occurrences: JSON.stringify([Date.parse("2026-11-16T09:00:00Z"), Date.parse("2026-11-30T09:00:00Z")]) });
	addEvent(sql, { id: "o1", title: "Moved", dav_object_id: "m1", recurrence_id: sec("2026-11-16T09:00:00Z"), starts_at: sec("2026-11-16T14:00:00Z"), ends_at: sec("2026-11-16T15:00:00Z"), time_zone: "Europe/Berlin" });
	sql.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('m1', 'u1', 'cal:u1', 'ios-series.ics', 'UID-FROM-PHONE', 0, 1, 1)").run();
	const listed = hrefs(await (await propfind(env, CAL, key, "<A:getetag/>", "1")).text());
	assert.deepEqual(listed.slice(1), [`${CAL}ios-series.ics`], "overrides are not resources of their own");
	const body = await (await call(env, "GET", `${CAL}ios-series.ics`, { key })).text();
	assert.equal(body.match(/UID:UID-FROM-PHONE/g).length, 2);
	assert.match(body, /RRULE:FREQ=WEEKLY;INTERVAL=2\r\n/);
	// The override's instant is no longer an EXDATE of the master (the override stands in for it); the other exclusion stays.
	assert.ok(!body.includes("EXDATE;TZID=Europe/Berlin:20261116"));
	assert.match(body, /EXDATE;TZID=Europe\/Berlin:20261130T100000\r\n/);
	assert.match(body, /RECURRENCE-ID;TZID=Europe\/Berlin:20261116T100000\r\n/);
	assert.match(body, /SUMMARY:Moved\r\n/);
	// Neither the native-style name nor the override's id reaches it.
	assert.equal((await call(env, "GET", `${CAL}m1.ics`, { key })).status, 404);
	assert.equal((await call(env, "GET", `${CAL}o1.ics`, { key })).status, 404);
});

test("all-day events are DATE values", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "d1", all_day: 1, time_zone: "Europe/Berlin", starts_at: sec("2026-11-04T23:00:00Z"), ends_at: sec("2026-11-05T23:00:00Z") });
	const body = await (await call(env, "GET", `${CAL}d1.ics`, { key })).text();
	assert.match(body, /DTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261106\r\n/);
});

test("PROPFIND on a resource answers its live properties", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1" });
	const text = await (await propfind(env, `${CAL}e1.ics`, key, "<A:getetag/><A:getcontentlength/><A:resourcetype/><A:displayname/>")).text();
	const length = (await (await call(env, "GET", `${CAL}e1.ics`, { key })).text()).length;
	assert.match(text, new RegExp(`<D:getcontentlength>${length}</D:getcontentlength>`));
	assert.match(text, /<D:resourcetype\/>/);
	assert.match(text, /HTTP\/1\.1 404 Not Found/);
});

test("calendar-multiget returns data, a 404 for missing, foreign and foreign-origin hrefs, and dedupes", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1" });
	addEvent(sql, { id: "e2", title: "Second" });
	addEvent(sql, { id: "theirs", user_id: "u2" });
	addEvent(sql, { id: "pending", response_status: "needs-action" });
	const body = `<C:calendar-multiget ${NS}><A:prop><A:getetag/><C:calendar-data/></A:prop>
		<A:href>${CAL}e1.ics</A:href><A:href>${CAL}e1.ics</A:href><A:href>${ORIGIN}${CAL}e2.ics</A:href>
		<A:href>${CAL}missing.ics</A:href><A:href>/dav/calendars/u2/default/theirs.ics</A:href><A:href>${CAL}theirs.ics</A:href><A:href>${CAL}pending.ics</A:href>
		<A:href>https://evil.example/dav/calendars/u1/default/e1.ics</A:href><A:href>%zz</A:href></C:calendar-multiget>`;
	const response = await report(env, CAL, key, body);
	assert.equal(response.status, 207);
	const text = await response.text();
	assert.equal(text.match(/BEGIN:VCALENDAR/g).length, 2);
	assert.equal(text.split(`<D:href>${CAL}e1.ics</D:href>`).length, 2, "e1 once");
	assert.match(text, /SUMMARY:Second/);
	for (const missing of [`${CAL}missing.ics`, `${CAL}theirs.ics`, `${CAL}pending.ics`, "/dav/calendars/u2/default/theirs.ics", "https://evil.example/dav/calendars/u1/default/e1.ics", "%zz"]) {
		assert.match(text, new RegExp(`<D:href>${missing.replace(/[/.]/g, "\\$&")}</D:href><D:status>HTTP/1.1 404 Not Found</D:status>`), missing);
	}
	assert.doesNotMatch(text, /UID:theirs@mailflare|UID:pending@mailflare/);
});

test("multiget refuses more than 200 hrefs and stays inside the statement budget at 200", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	for (let i = 0; i < 200; i++) addEvent(sql, { id: `m${i}` });
	const make = (count) => `<C:calendar-multiget ${NS}><A:prop><A:getetag/><C:calendar-data/></A:prop>${Array.from({ length: count }, (_, i) => `<A:href>${CAL}m${i}.ics</A:href>`).join("")}</C:calendar-multiget>`;
	const tooMany = await report(env, CAL, key, make(201));
	assert.equal(tooMany.status, 403);
	assert.match(await tooMany.text(), /<D:number-of-matches-within-limits\/>/);
	stats.queries = 0;
	stats.maxParams = 0;
	const response = await report(env, CAL, key, make(200));
	const text = await response.text();
	assert.equal(text.match(/BEGIN:VCALENDAR/g).length, 200);
	assert.ok(stats.queries <= 30, `statements: ${stats.queries}`);
	assert.ok(stats.maxParams < 100, `bound parameters: ${stats.maxParams}`);
});

test("calendar-query: time-range after recurrence expansion across a DST change", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "once-in", starts_at: sec("2026-11-10T10:00:00Z"), ends_at: sec("2026-11-10T11:00:00Z") });
	addEvent(sql, { id: "once-out", starts_at: sec("2026-12-10T10:00:00Z"), ends_at: sec("2026-12-10T11:00:00Z") });
	addEvent(sql, { id: "weekly", repeat: "weekly", time_zone: "Europe/Berlin", starts_at: sec("2026-10-12T07:00:00Z"), ends_at: sec("2026-10-12T08:00:00Z") });
	addEvent(sql, { id: "ended", repeat: "weekly", repeat_until: sec("2026-10-20T00:00:00Z"), starts_at: sec("2026-10-12T07:00:00Z"), ends_at: sec("2026-10-12T08:00:00Z") });
	addEvent(sql, { id: "late", repeat: "daily", starts_at: sec("2027-06-01T07:00:00Z"), ends_at: sec("2027-06-01T08:00:00Z") });
	addEvent(sql, { id: "pending", response_status: "needs-action", starts_at: sec("2026-11-10T10:00:00Z"), ends_at: sec("2026-11-10T11:00:00Z") });
	const query = (range) => `<C:calendar-query ${NS}><A:prop><A:getetag/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">${range}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
	const ids = async (range) => hrefs(await (await report(env, CAL, key, query(range))).text()).map((h) => h.replace(CAL, "").replace(".ics", "")).sort();
	assert.deepEqual(await ids(`<C:time-range start="20261101T000000Z" end="20261201T000000Z"/>`), ["once-in", "weekly"]);
	// Mondays 09:00 Berlin: 19 Oct is 07:00Z (summer time), 26 Oct is 08:00Z (the clocks went back on 25 Oct).
	assert.deepEqual(await ids(`<C:time-range start="20261019T070000Z" end="20261019T073000Z"/>`), ["ended", "weekly"]);
	assert.deepEqual(await ids(`<C:time-range start="20261026T070000Z" end="20261026T075900Z"/>`), [], "07:00Z is no longer when the series starts");
	assert.deepEqual(await ids(`<C:time-range start="20261026T080000Z" end="20261026T083000Z"/>`), ["weekly"]);
	assert.deepEqual(await ids(`<C:time-range start="20261019T080000Z" end="20261019T090000Z"/>`), [], "an occurrence that ends exactly at the start is not in range");
	assert.deepEqual(await ids(`<C:time-range start="20260101T000000Z"/>`), ["ended", "late", "once-in", "once-out", "weekly"]);
	assert.deepEqual(await ids(`<C:time-range end="20261001T000000Z"/>`), []);
	assert.deepEqual(await ids(""), ["ended", "late", "once-in", "once-out", "weekly"]);
});

test("calendar-query by UID, other components and unsupported filters", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1" });
	addEvent(sql, { id: "e2" });
	addEvent(sql, { id: "dav1", dav_object_id: "dav1" });
	sql.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('dav1', 'u1', 'cal:u1', 'x.ics', 'THE-UID', 0, 1, 1)").run();
	const query = (inner, outer = "") => `<C:calendar-query ${NS}><A:prop><A:getetag/></A:prop><C:filter><C:comp-filter name="VCALENDAR">${outer}<C:comp-filter name="VEVENT">${inner}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
	const uid = (value) => `<C:prop-filter name="UID"><C:text-match>${value}</C:text-match></C:prop-filter>`;
	assert.deepEqual(hrefs(await (await report(env, CAL, key, query(uid("e2@mailflare")))).text()), [`${CAL}e2.ics`]);
	assert.deepEqual(hrefs(await (await report(env, CAL, key, query(uid("THE-UID")))).text()), [`${CAL}x.ics`]);
	assert.deepEqual(hrefs(await (await report(env, CAL, key, query(uid("e2")))).text()), [], "equality, not substring");
	const todos = `<C:calendar-query ${NS}><A:prop><A:getetag/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter></C:calendar-query>`;
	const none = await report(env, CAL, key, todos);
	assert.equal(none.status, 207);
	assert.deepEqual(hrefs(await none.text()), []);
	for (const inner of [`<C:prop-filter name="SUMMARY"><C:text-match>x</C:text-match></C:prop-filter>`, `<C:comp-filter name="VALARM"/>`, `<C:prop-filter name="UID"><C:is-not-defined/></C:prop-filter>`]) {
		const refused = await report(env, CAL, key, query(inner));
		assert.equal(refused.status, 403, inner);
		assert.match(await refused.text(), /<C:supported-filter\/>/);
	}
	const badRange = await report(env, CAL, key, query(`<C:time-range start="2026-11-01"/>`));
	assert.equal(badRange.status, 403);
	assert.match(await badRange.text(), /<C:valid-filter\/>/);
	assert.equal((await report(env, CAL, key, query(`<C:time-range start="20261201T000000Z" end="20261101T000000Z"/>`))).status, 403);
	const missingFilter = await report(env, CAL, key, `<C:calendar-query ${NS}><A:prop><A:getetag/></A:prop></C:calendar-query>`);
	assert.equal(missingFilter.status, 403);
});

test("calendar-data options this server does not do are refused, not ignored", async (t) => {
	const { env, key } = await fixture(t);
	for (const data of [`<C:calendar-data><C:expand start="20261101T000000Z" end="20261201T000000Z"/></C:calendar-data>`, `<C:calendar-data><C:limit-recurrence-set start="20261101T000000Z" end="20261201T000000Z"/></C:calendar-data>`, `<C:calendar-data content-type="text/x-other"/>`]) {
		const response = await report(env, CAL, key, `<C:calendar-multiget ${NS}><A:prop><A:getetag/>${data}</A:prop><A:href>${CAL}x.ics</A:href></C:calendar-multiget>`);
		assert.equal(response.status, 403, data);
		assert.match(await response.text(), /<C:supported-calendar-data\/>/);
	}
});

test("a calendar-query over 1000 events answers the first 1000 and a 507, in a bounded number of statements", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	sql.exec("BEGIN");
	for (let i = 0; i < 1100; i++) addEvent(sql, { id: `q${String(i).padStart(4, "0")}` });
	sql.exec("COMMIT");
	stats.queries = 0;
	stats.maxParams = 0;
	const response = await report(env, CAL, key, `<C:calendar-query ${NS}><A:prop><A:getetag/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`);
	const text = await response.text();
	assert.equal((text.match(/<D:getetag>/g) ?? []).length, 1000);
	assert.match(text, new RegExp(`<D:href>${CAL}</D:href><D:status>HTTP/1\\.1 507 Insufficient Storage</D:status><D:error><D:number-of-matches-within-limits/></D:error>`));
	assert.ok(stats.queries < 50, `statements: ${stats.queries}`);
	assert.ok(stats.maxParams < 100, `bound parameters: ${stats.maxParams}`);
});

test("sync-collection: first sync, incremental, destroyed and hidden resources", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1" });
	addEvent(sql, { id: "e2" });
	addEvent(sql, { id: "pending", response_status: "needs-action" });
	const sync = (token) => report(env, CAL, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`, "0");
	const first = await sync("");
	assert.equal(first.status, 207);
	const firstText = await first.text();
	assert.deepEqual(hrefs(firstText), [`${CAL}e1.ics`, `${CAL}e2.ics`]);
	const token = firstText.match(/<D:sync-token>([^<]*)<\/D:sync-token>$/m)?.[1] ?? firstText.match(/<D:sync-token>([^<]*)<\/D:sync-token><\/D:multistatus>/)[1];
	assert.match(token, /^https:\/\/mail\.example\.test\/dav\/sync\/cal%3Au1\/[0-9a-f-]{36}\/\d+$/);

	const none = await (await sync(token)).text();
	assert.deepEqual(hrefs(none), []);
	assert.ok(none.includes(`<D:sync-token>${token}</D:sync-token>`), "an unchanged collection keeps its token");

	sql.prepare("UPDATE calendar_events SET title = 'Changed', updated_at = updated_at + 1 WHERE id = 'e1'").run();
	sql.prepare("DELETE FROM calendar_events WHERE id = 'e2'").run();
	sql.prepare("UPDATE calendar_events SET response_status = 'accepted', updated_at = updated_at + 1 WHERE id = 'pending'").run();
	addEvent(sql, { id: "e3" });
	sql.prepare("UPDATE calendar_events SET response_status = 'declined', updated_at = updated_at + 1 WHERE id = 'e3'").run();
	const second = await (await sync(token)).text();
	assert.match(second, new RegExp(`<D:href>${CAL}e1.ics</D:href><D:propstat><D:prop><D:getetag>&quot;\\d+&quot;</D:getetag></D:prop><D:status>HTTP/1.1 200 OK`));
	assert.match(second, new RegExp(`<D:href>${CAL}pending.ics</D:href><D:propstat>`));
	assert.match(second, new RegExp(`<D:href>${CAL}e2.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`));
	assert.match(second, new RegExp(`<D:href>${CAL}e3.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`), "a resource that became hidden is reported gone");
	const next = second.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
	assert.notEqual(next, token);
	assert.deepEqual(hrefs(await (await sync(next)).text()), []);
});

test("sync-collection: tokens from another collection, epoch, the future or garbage are 403 valid-sync-token", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1" });
	const sync = (token) => report(env, CAL, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`, "0");
	const text = await (await sync("")).text();
	const good = text.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
	const bad = [good.replace(/\/\d+$/, "/999999"), good.replace(/[0-9a-f]{8}-/, "00000000-"), good.replace("cal%3Au1", "cal%3Au2"), good.replace("cal%3Au1", "card%3Au1"), "garbage", "https://x/dav/sync/", `${good}/extra`];
	for (const token of bad) {
		const response = await sync(token);
		assert.equal(response.status, 403, token);
		assert.match(await response.text(), /<D:valid-sync-token\/>/, token);
	}
	// A floor raised above the token (the log was pruned past it) forces a resync as well.
	sql.prepare("UPDATE dav_sync_state SET floor = 1000 WHERE collection_id = 'cal:u1'").run();
	assert.equal((await sync(good)).status, 403);
	const level = await report(env, CAL, key, `<A:sync-collection ${NS}><A:sync-token/><A:sync-level>infinite</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`, "0");
	assert.equal(level.status, 403);
	assert.equal((await report(env, CAL, key, `<A:sync-collection ${NS}><A:sync-token/><A:prop><A:getetag/></A:prop></A:sync-collection>`, "0")).status, 400);
});

test("sync-collection answers 500 changes, a 507 for the collection and a token to continue from", async (t) => {
	const { env, key, sql } = await fixture(t);
	const sync = (token) => report(env, CAL, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`, "0");
	const start = (await (await sync("")).text()).match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
	sql.exec("BEGIN");
	for (let i = 0; i < 520; i++) addEvent(sql, { id: `s${String(i).padStart(4, "0")}` });
	sql.exec("COMMIT");
	const page = await (await sync(start)).text();
	assert.equal(hrefs(page).filter((h) => h.endsWith(".ics")).length, 500);
	assert.match(page, new RegExp(`<D:href>${CAL}</D:href><D:status>HTTP/1\\.1 507 Insufficient Storage</D:status>`));
	const middle = page.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
	const rest = await (await sync(middle)).text();
	assert.equal(hrefs(rest).filter((h) => h.endsWith(".ics")).length, 20);
	assert.doesNotMatch(rest, /507 Insufficient/);
	const seen = new Set([...hrefs(page), ...hrefs(rest)].filter((h) => h.endsWith(".ics")));
	assert.equal(seen.size, 520);
});

test("a large first sync costs a handful of statements", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	sql.exec("BEGIN");
	for (let i = 0; i < 1500; i++) addEvent(sql, { id: `f${i}` });
	sql.exec("COMMIT");
	stats.queries = 0;
	const text = await (await report(env, CAL, key, `<A:sync-collection ${NS}><A:sync-token/><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`, "0")).text();
	assert.equal((text.match(/<D:getetag>/g) ?? []).length, 1500);
	assert.ok(stats.queries <= 12, `statements: ${stats.queries}`);
});

test("auth comes before parsing; bodies are bounded; unknown reports are refused", async (t) => {
	const { env, key } = await fixture(t);
	assert.equal((await call(env, "REPORT", CAL, { body: "<not xml", headers: xml })).status, 401);
	assert.equal((await call(env, "REPORT", CAL, { key, body: "<not xml", headers: xml })).status, 400);
	assert.equal((await call(env, "REPORT", CAL, { key, headers: xml })).status, 400);
	assert.equal((await call(env, "REPORT", CAL, { key, body: `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav">&e;</C:calendar-query>`, headers: xml })).status, 400);
	assert.equal((await call(env, "REPORT", CAL, { key, body: `<a>${" ".repeat(256 * 1024)}</a>`, headers: xml })).status, 413);
	assert.equal((await call(env, "REPORT", CAL, { key, body: `<a/>`, headers: { "Content-Type": "application/json" } })).status, 415);
	const other = await report(env, CAL, key, `<A:version-tree ${NS}/>`);
	assert.equal(other.status, 403);
	assert.match(await other.text(), /<D:supported-report\/>/);
	// A CardDAV report on the calendar (and the reverse) is not supported there.
	assert.equal((await report(env, CAL, key, `<R:addressbook-query ${NS}><A:prop><A:getetag/></A:prop></R:addressbook-query>`)).status, 403);
	assert.equal((await report(env, BOOK, key, `<C:calendar-query ${NS}/>`)).status, 403);
	assert.equal((await report(env, CAL, key, `<A:sync-collection ${NS}/>`, "infinity")).status, 403);
	assert.equal((await report(env, CAL, key, `<A:sync-collection ${NS}/>`, "7")).status, 400);
	assert.equal((await report(env, "/dav/principals/u1/", key, `<A:expand-property ${NS}/>`)).status, 405);
	assert.equal((await report(env, "/dav/calendars/u2/default/", key, `<A:sync-collection ${NS}/>`)).status, 404);
});

test("with calendars turned off for the account the calendar is 403 and contacts still work", async (t) => {
	const { env, key } = await fixture(t, { calendarEnabled: false });
	for (const path of [CAL, `${CAL}e1.ics`]) assert.equal((await propfind(env, path, key, "<A:resourcetype/>")).status, 403, path);
	assert.equal((await report(env, CAL, key, `<A:sync-collection ${NS}/>`, "0")).status, 403);
	assert.equal((await call(env, "GET", `${CAL}e1.ics`, { key })).status, 403);
	assert.equal((await propfind(env, BOOK, key, "<A:resourcetype/>")).status, 207);
});

test("the address book collection and its cards", async (t) => {
	const { env, key, sql } = await fixture(t);
	addCard(sql, { id: "c1", name: "ann.vcf", uid: "UID-ANN", fn: "Ann Lee", emails: '["ann@one.test","a.lee@two.test"]' });
	addCard(sql, { id: "c2", name: "bob.vcf", uid: "UID-BOB", fn: "Bob", emails: '["bob@one.test"]', version: "4.0", body: "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:UID-BOB\r\nFN:Bob\r\nEND:VCARD\r\n" });
	addCard(sql, { id: "c3", user_id: "u2", collection_id: "card:u2", name: "other.vcf", uid: "U3", fn: "Other" });
	const props = await (await propfind(env, BOOK, key, "<A:resourcetype/><A:displayname/><R:supported-address-data/><R:max-resource-size/><A:supported-report-set/><S:getctag/><A:sync-token/><A:current-user-privilege-set/>")).text();
	assert.match(props, /<D:resourcetype><D:collection\/><CR:addressbook\/><\/D:resourcetype>/);
	assert.match(props, /<D:displayname>Contacts<\/D:displayname>/);
	assert.match(props, /<CR:address-data-type content-type="text\/vcard" version="3\.0"\/><CR:address-data-type content-type="text\/vcard" version="4\.0"\/>/);
	assert.match(props, /<D:sync-token>https:\/\/mail\.example\.test\/dav\/sync\/card%3Au1\//);
	assert.match(props, /<CR:addressbook-query\/>/);
	const listing = await (await propfind(env, BOOK, key, "<A:getetag/><A:getcontentlength/><A:getcontenttype/>", "1")).text();
	assert.deepEqual(hrefs(listing).slice(1), [`${BOOK}ann.vcf`, `${BOOK}bob.vcf`]);
	assert.match(listing, /<D:getcontenttype>text\/vcard; charset=utf-8<\/D:getcontenttype>/);
	const card = await call(env, "GET", `${BOOK}bob.vcf`, { key });
	assert.equal(card.status, 200);
	assert.equal(card.headers.get("Content-Type"), "text/vcard; charset=utf-8");
	assert.equal(await card.text(), "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:UID-BOB\r\nFN:Bob\r\nEND:VCARD\r\n");
	assert.equal((await call(env, "GET", `${BOOK}other.vcf`, { key })).status, 404);
	assert.equal((await call(env, "GET", `${BOOK}ann.ics`, { key })).status, 400);
	assert.equal((await call(env, "GET", "/dav/addressbooks/u2/default/other.vcf", { key })).status, 404);
	const etag = (await call(env, "GET", `${BOOK}ann.vcf`, { key })).headers.get("ETag");
	assert.equal((await call(env, "GET", `${BOOK}ann.vcf`, { key, headers: { "If-None-Match": etag } })).status, 304);
});

test("addressbook-multiget and addressbook-query", async (t) => {
	const { env, key, sql } = await fixture(t);
	addCard(sql, { id: "c1", name: "ann.vcf", uid: "UID-ANN", fn: "Ann Lee", emails: '["ann@one.test","a.lee@two.test"]' });
	addCard(sql, { id: "c2", name: "bob.vcf", uid: "UID-BOB", fn: "Bob Marley", emails: '["bob@one.test"]' });
	addCard(sql, { id: "c3", name: "cy.vcf", uid: "UID-CY", fn: "Cy", emails: "[]" });
	const multiget = await (await report(env, BOOK, key, `<R:addressbook-multiget ${NS}><A:prop><A:getetag/><R:address-data/></A:prop><A:href>${BOOK}ann.vcf</A:href><A:href>${BOOK}none.vcf</A:href></R:addressbook-multiget>`)).text();
	assert.match(multiget, /<CR:address-data>BEGIN:VCARD/);
	assert.match(multiget, new RegExp(`<D:href>${BOOK}none.vcf</D:href><D:status>HTTP/1.1 404 Not Found`));
	const query = async (filter, extra = "", prop = "<A:getetag/>") => hrefs(await (await report(env, BOOK, key, `<R:addressbook-query ${NS}><A:prop>${prop}</A:prop>${filter ? `<R:filter${/test="allof"/.test(extra) ? ' test="allof"' : ""}>${filter}</R:filter>` : ""}${extra.replace(/test="allof"/, "")}</R:addressbook-query>`)).text()).filter((h) => h.endsWith(".vcf")).map((h) => h.replace(BOOK, ""));
	const prop = (name, match, attrs = "") => `<R:prop-filter name="${name}"><R:text-match ${attrs}>${match}</R:text-match></R:prop-filter>`;
	assert.deepEqual(await query(""), ["ann.vcf", "bob.vcf", "cy.vcf"]);
	assert.deepEqual(await query(prop("FN", "MARLEY")), ["bob.vcf"], "contains, case-insensitive");
	assert.deepEqual(await query(prop("EMAIL", "a.lee@TWO.test", 'match-type="equals"')), ["ann.vcf"]);
	assert.deepEqual(await query(prop("EMAIL", "bob", 'match-type="starts-with"')), ["bob.vcf"]);
	assert.deepEqual(await query(prop("FN", "ann", 'negate-condition="yes"')), ["bob.vcf", "cy.vcf"]);
	assert.deepEqual(await query(prop("UID", "UID-CY", 'match-type="equals" collation="i;octet"')), ["cy.vcf"]);
	assert.deepEqual(await query(prop("UID", "uid-cy", 'match-type="equals" collation="i;octet"')), []);
	assert.deepEqual(await query(prop("FN", "o") + prop("EMAIL", "ann")), ["ann.vcf", "bob.vcf"], "anyof by default");
	assert.deepEqual(await query(prop("FN", "o") + prop("EMAIL", "ann"), 'test="allof"'), []);
	assert.deepEqual(await query('<R:prop-filter name="EMAIL"><R:is-not-defined/></R:prop-filter>'), ["cy.vcf"]);
	assert.deepEqual(await query("", "<R:limit><R:nresults>2</R:nresults></R:limit>"), ["ann.vcf", "bob.vcf"]);
	const limited = await (await report(env, BOOK, key, `<R:addressbook-query ${NS}><A:prop><A:getetag/></A:prop><R:limit><R:nresults>2</R:nresults></R:limit></R:addressbook-query>`)).text();
	assert.match(limited, /507 Insufficient Storage/);
	for (const name of ["NICKNAME", "TEL"]) {
		const refused = await report(env, BOOK, key, `<R:addressbook-query ${NS}><A:prop><A:getetag/></A:prop><R:filter>${prop(name, "x")}</R:filter></R:addressbook-query>`);
		assert.equal(refused.status, 403, name);
		assert.match(await refused.text(), /<CR:supported-filter\/>/);
	}
	const withData = await query("", "", "<R:address-data/>");
	assert.equal(withData.length, 3);
	assert.equal((await report(env, BOOK, key, `<R:addressbook-multiget ${NS}><A:prop><R:address-data content-type="text/x-other"/></A:prop></R:addressbook-multiget>`)).status, 403);
});

test("sync-collection on the address book", async (t) => {
	const { env, key, sql } = await fixture(t);
	addCard(sql, { id: "c1", name: "ann.vcf" });
	const sync = (token) => report(env, BOOK, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/><R:address-data/></A:prop></A:sync-collection>`, "0");
	const first = await (await sync("")).text();
	assert.deepEqual(hrefs(first), [`${BOOK}ann.vcf`]);
	// Data properties are not offered in a sync answer: the client follows up with a multiget.
	assert.match(first, /HTTP\/1\.1 404 Not Found/);
	assert.doesNotMatch(first, /BEGIN:VCARD/);
	const token = first.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
	assert.match(token, /card%3Au1/);
	addCard(sql, { id: "c2", name: "bob.vcf" });
	sql.prepare("DELETE FROM dav_cards WHERE id = 'c1'").run();
	const second = await (await sync(token)).text();
	assert.match(second, new RegExp(`<D:href>${BOOK}bob.vcf</D:href><D:propstat>`));
	assert.match(second, new RegExp(`<D:href>${BOOK}c1.vcf</D:href><D:status>HTTP/1.1 404`));
	assert.equal((await sync(token.replace("card%3Au1", "cal%3Au1"))).status, 403);
});

test("a response over 16 MiB is cut with a 507 and no further resources", async (t) => {
	const { env, key, sql } = await fixture(t);
	const big = "X".repeat(1_000_000);
	for (let i = 0; i < 30; i++) addCard(sql, { id: `big${i}`, name: `big${String(i).padStart(2, "0")}.vcf`, body: `BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:${big}\r\nEND:VCARD\r\n`, size: 1_000_040 });
	const response = await report(env, BOOK, key, `<R:addressbook-query ${NS}><A:prop><A:getetag/><R:address-data/></A:prop></R:addressbook-query>`);
	const text = await response.text();
	const cards = text.match(/BEGIN:VCARD/g).length;
	assert.ok(cards >= 16 && cards < 30, `cards: ${cards}`);
	assert.match(text, /507 Insufficient Storage/);
	assert.ok(text.length < 25_000_000, `length: ${text.length}`);
});

const eventsBulk = (sql, count, fields) => {
	sql.exec("BEGIN");
	for (let i = 0; i < count; i++) addEvent(sql, { id: `b${String(i).padStart(5, "0")}`, ...(typeof fields === "function" ? fields(i) : fields) });
	sql.exec("COMMIT");
};
const syncAll = (env, key, area = CAL) => report(env, area, key, `<A:sync-collection ${NS}><A:sync-token/><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`, "0");
const reset = (stats) => ((stats.queries = 0), (stats.maxParams = 0), (stats.maxRows = 0));
const countEtags = (text) => (text.match(/<D:getetag>/g) ?? []).length;

test("a calendar of 5001 events lists at depth 1 and first-syncs in few statements", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	eventsBulk(sql, 5001);
	reset(stats);
	const listing = await propfind(env, CAL, key, "<A:getetag/>", "1");
	assert.equal(listing.status, 207);
	const text = await listing.text();
	assert.equal(countEtags(text), 5001);
	assert.ok(stats.queries <= 40 && stats.maxRows <= 1000, `statements: ${stats.queries}, rows per statement: ${stats.maxRows}`);
	reset(stats);
	const sync = await syncAll(env, key);
	assert.equal(sync.status, 207);
	assert.equal(countEtags(await sync.text()), 5001);
	assert.ok(stats.queries <= 40 && stats.maxRows <= 1000, `statements: ${stats.queries}, rows per statement: ${stats.maxRows}`);
});

test("20,000 events still list and sync; one more is a 507, for PROPFIND and the first sync alike", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	eventsBulk(sql, 20000);
	reset(stats);
	const listing = await propfind(env, CAL, key, "<A:getetag/>", "1");
	assert.equal(listing.status, 207);
	const listed = await listing.text();
	assert.equal(countEtags(listed), 20000);
	assert.equal(new Set(hrefs(listed)).size, 20001, "every event once, plus the collection");
	assert.ok(stats.queries <= 40 && stats.maxRows <= 1000, `statements: ${stats.queries}, rows per statement: ${stats.maxRows}`);
	reset(stats);
	const sync = await syncAll(env, key);
	assert.equal(sync.status, 207);
	const synced = await sync.text();
	assert.equal(countEtags(synced), 20000);
	assert.match(synced, /<D:sync-token>https:\/\/mail\.example\.test\/dav\/sync\/cal%3Au1\//);
	assert.ok(stats.queries <= 40 && stats.maxRows <= 1000, `statements: ${stats.queries}, rows per statement: ${stats.maxRows}`);

	addEvent(sql, { id: "zz-one-too-many" });
	for (const response of [await propfind(env, CAL, key, "<A:getetag/>", "1"), await syncAll(env, key)]) {
		assert.equal(response.status, 507);
		assert.match(await response.text(), /<D:number-of-matches-within-limits\/>/);
	}
});

test("the address book lists and syncs 5001 cards; 20,001 is a 507", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	sql.exec("BEGIN");
	for (let i = 0; i < 5001; i++) addCard(sql, { id: `k${String(i).padStart(5, "0")}`, name: `k${String(i).padStart(5, "0")}.vcf`, uid: `U${i}`, fn: `P${i}` });
	sql.exec("COMMIT");
	reset(stats);
	const listing = await propfind(env, BOOK, key, "<A:getetag/>", "1");
	assert.equal(listing.status, 207);
	assert.equal(countEtags(await listing.text()), 5001);
	assert.ok(stats.queries <= 40 && stats.maxRows <= 1000, `statements: ${stats.queries}, rows per statement: ${stats.maxRows}`);
	reset(stats);
	const sync = await syncAll(env, key, BOOK);
	assert.equal(sync.status, 207);
	assert.equal(countEtags(await sync.text()), 5001);
	assert.ok(stats.queries <= 40 && stats.maxRows <= 1000, `statements: ${stats.queries}, rows per statement: ${stats.maxRows}`);
	sql.exec("BEGIN");
	for (let i = 5001; i < 20000; i++) addCard(sql, { id: `k${String(i).padStart(5, "0")}`, name: `k${String(i).padStart(5, "0")}.vcf`, uid: `U${i}`, fn: `P${i}` });
	sql.exec("COMMIT");
	assert.equal((await propfind(env, BOOK, key, "<A:getetag/>", "1")).status, 207, "20,000 cards are listed");
	addCard(sql, { id: "kzzzzz", name: "kzzzzz.vcf", uid: "UZ", fn: "Z" });
	assert.equal((await propfind(env, BOOK, key, "<A:getetag/>", "1")).status, 507);
	assert.equal((await syncAll(env, key, BOOK)).status, 507);
});

test("calendar-query with 2000 candidates and DAV overrides stays under 40 statements", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	// 2000 DAV series that ended in October; five of them have an occurrence moved into November.
	sql.exec("BEGIN");
	for (let i = 0; i < 2000; i++) {
		const id = `m${String(i).padStart(4, "0")}`;
		addEvent(sql, { id, dav_object_id: id, repeat: "custom", rrule: "FREQ=WEEKLY;COUNT=2", starts_at: sec("2026-10-05T09:00:00Z"), ends_at: sec("2026-10-05T10:00:00Z"), time_zone: "Europe/Berlin" });
		if (i % 400 === 0) addEvent(sql, { id: `o${i}`, title: `Moved ${i}`, dav_object_id: id, recurrence_id: sec("2026-10-12T09:00:00Z"), starts_at: sec("2026-11-10T09:00:00Z"), ends_at: sec("2026-11-10T10:00:00Z"), time_zone: "Europe/Berlin" });
	}
	sql.exec("COMMIT");
	reset(stats);
	const response = await report(env, CAL, key, `<C:calendar-query ${NS}><A:prop><A:getetag/><C:calendar-data/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20261101T000000Z" end="20261201T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
	assert.equal(response.status, 207);
	const text = await response.text();
	assert.equal(countEtags(text), 5);
	assert.equal((text.match(/RECURRENCE-ID/g) ?? []).length, 5, "a series that matches through an override still carries it");
	assert.doesNotMatch(text, /507/);
	assert.ok(stats.queries <= 40, `statements: ${stats.queries}`);
	assert.ok(stats.maxParams < 100);
});

test("series that ended before the range do not count against the candidate cap", async (t) => {
	const { env, key, sql } = await fixture(t);
	sql.exec("BEGIN");
	for (let i = 0; i < 1100; i++) addEvent(sql, { id: `a-legacy${i}`, repeat: "weekly", repeat_until: sec("2026-10-20T00:00:00Z"), starts_at: sec("2026-10-05T09:00:00Z"), ends_at: sec("2026-10-05T10:00:00Z") });
	for (let i = 0; i < 1100; i++) addEvent(sql, { id: `a-custom${i}`, repeat: "custom", rrule: "FREQ=DAILY;UNTIL=20261020T000000Z", starts_at: sec("2026-10-05T09:00:00Z"), ends_at: sec("2026-10-05T10:00:00Z"), time_zone: "Europe/Berlin" });
	// An ended series made by a DAV client can still have an override moved into the range.
	addEvent(sql, { id: "a-dav", dav_object_id: "a-dav", repeat: "weekly", repeat_until: sec("2026-10-20T00:00:00Z"), starts_at: sec("2026-10-05T09:00:00Z"), ends_at: sec("2026-10-05T10:00:00Z") });
	addEvent(sql, { id: "a-dav-moved", dav_object_id: "a-dav", recurrence_id: sec("2026-10-12T09:00:00Z"), starts_at: sec("2026-11-10T09:00:00Z"), ends_at: sec("2026-11-10T10:00:00Z") });
	addEvent(sql, { id: "z-live1", starts_at: sec("2026-11-10T09:00:00Z"), ends_at: sec("2026-11-10T10:00:00Z") });
	addEvent(sql, { id: "z-live2", repeat: "daily", starts_at: sec("2026-11-01T09:00:00Z"), ends_at: sec("2026-11-01T10:00:00Z") });
	sql.exec("COMMIT");
	const response = await report(env, CAL, key, `<C:calendar-query ${NS}><A:prop><A:getetag/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20261105T000000Z" end="20261201T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
	const text = await response.text();
	assert.deepEqual(hrefs(text).map((h) => h.replace(CAL, "")).sort(), ["a-dav.ics", "z-live1.ics", "z-live2.ics"]);
	assert.doesNotMatch(text, /507/);
});

test("If-Match is a strong comparison: a weak validator never matches", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "e1" });
	const etag = (await call(env, "GET", `${CAL}e1.ics`, { key })).headers.get("ETag");
	const ifMatch = async (value) => (await call(env, "GET", `${CAL}e1.ics`, { key, headers: { "If-Match": value } })).status;
	assert.equal(await ifMatch(etag), 200);
	assert.equal(await ifMatch(`"nope", ${etag}`), 200);
	assert.equal(await ifMatch("*"), 200);
	assert.equal(await ifMatch(`W/${etag}`), 412);
	assert.equal(await ifMatch(`"nope", W/${etag}`), 412);
	// If-None-Match keeps the weak comparison.
	assert.equal((await call(env, "GET", `${CAL}e1.ics`, { key, headers: { "If-None-Match": `W/${etag}` } })).status, 304);
});

test("the first reminder is written as a VALARM relative to the start; none without one", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "with", title: "Dentist", reminder_minutes: 30 });
	addEvent(sql, { id: "without" });
	addEvent(sql, { id: "series", dav_object_id: "series", repeat: "weekly", time_zone: "Europe/Berlin", reminder_minutes: 0 });
	addEvent(sql, { id: "series-moved", dav_object_id: "series", recurrence_id: sec("2026-11-09T17:00:00Z"), time_zone: "Europe/Berlin", reminder_minutes: 5, starts_at: sec("2026-11-09T18:00:00Z"), ends_at: sec("2026-11-09T19:00:00Z") });
	const body = (name) => call(env, "GET", `${CAL}${name}.ics`, { key }).then((response) => response.text());
	assert.match(await body("with"), /DTSTAMP:\d+T\d+Z\r\n.*?LAST-MODIFIED:\d+T\d+Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Dentist\r\nTRIGGER:-PT30M\r\nEND:VALARM\r\nEND:VEVENT/s);
	assert.doesNotMatch(await body("without"), /VALARM|TRIGGER/);
	const series = await body("series");
	assert.deepEqual(series.match(/TRIGGER:[^\r]*/g), ["TRIGGER:PT0S", "TRIGGER:-PT5M"]);
});

test("an all-day event without a zone of its own uses the user's zone", async (t) => {
	const { env, key, sql } = await fixture(t);
	// u1's zone is Europe/Berlin: these midnights are 5 and 6 November there.
	addEvent(sql, { id: "d2", all_day: 1, repeat: "daily", repeat_until: sec("2026-11-08T23:00:00Z"), starts_at: sec("2026-11-04T23:00:00Z"), ends_at: sec("2026-11-05T23:00:00Z") });
	const body = await (await call(env, "GET", `${CAL}d2.ics`, { key })).text();
	assert.match(body, /DTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261106\r\n/);
	assert.match(body, /RRULE:FREQ=DAILY;UNTIL=20261108\r\n/);
});

test("a series that started long ago still lists the transitions of this year onward", async (t) => {
	const { env, key, sql } = await fixture(t);
	addEvent(sql, { id: "old", repeat: "weekly", time_zone: "Europe/Berlin", starts_at: sec("2004-03-01T09:00:00Z"), ends_at: sec("2004-03-01T10:00:00Z") });
	const body = await (await call(env, "GET", `${CAL}old.ics`, { key })).text();
	const rdates = (body.match(/RDATE:[^\r]*/g) ?? []).join(",");
	assert.match(rdates, /20040328T020000/);
	assert.match(rdates, new RegExp(`${new Date().getUTCFullYear()}0\\d{3}T0[23]0000`));
});

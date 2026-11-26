import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// CS-4: every own calendar is a collection of the CalDAV home (spec F9 D-12), each with its own events and change log.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-cal-dav-collections-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest } from "./src/lib/dav/handler.ts";
			export { clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { deleteCalendar } from "./src/lib/calendar/calendars.ts";
			export { moveSeriesStatements } from "./src/lib/calendar/series-rows.ts";
			export { getDb } from "./src/db/index.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "cal-dav-collections-entry.ts",
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
const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, deleteCalendar, moveSeriesStatements, getDb, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";
const HOME = "/dav/calendars/u1/";
const DEFAULT = `${HOME}default/`;
const WORK = `${HOME}c-work/`;
const XML = { "Content-Type": "application/xml" };
const ICS = { "Content-Type": "text/calendar; charset=utf-8" };

/** The database wrapped so a test can count statements and the most bound parameters one carried. */
function counting(database) {
	const stats = { queries: 0, maxParams: 0 };
	const wrap = (statement, params = 0) => {
		const count = () => (stats.queries++, (stats.maxParams = Math.max(stats.maxParams, params)));
		return {
			bind: (...values) => wrap(statement.bind(...values), values.length),
			run: () => (count(), statement.run()),
			all: () => (count(), statement.all()),
			raw: (options) => (count(), statement.raw(options)),
			first: (column) => (count(), statement.first(column)),
		};
	};
	const proxy = new Proxy(database, { get: (target, key) => (key === "prepare" ? (sql) => wrap(target.prepare(sql)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
	return { proxy, stats };
}

async function fixture(t, { extras = ["cal:work"] } = {}) {
	clearApiKeyVerificationCache();
	clearDavEnabledCache();
	const database = new SqliteDatabase(":memory:");
	t.after(() => { database.db.close(); clearApiKeyVerificationCache(); clearDavEnabledCache(); });
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const user = sql.prepare("INSERT INTO users (id, email, name, password_hash, role, calendar_enabled, time_zone, created_at) VALUES (?, ?, ?, 'x', 'user', 1, 'Europe/Berlin', 1)");
	user.run("u1", "u1@one.test", "User One");
	user.run("u2", "u2@one.test", "User Two");
	sql.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	const keys = {};
	for (const id of ["u1", "u2"]) {
		keys[id] = await generateAppPassword();
		sql.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES (?, ?, 'phone', ?, ?, ?, 'app', '[\"dav\"]', 1)").run(`k-${id}`, id, keys[id].prefix, keys[id].hash, keys[id].sha256);
	}
	const insertCalendar = sql.prepare("INSERT INTO dav_collections (id, user_id, kind, display_name, color, created_at, updated_at) VALUES (?, ?, 'calendar', ?, '#0ea5e9', ?, ?)");
	extras.forEach((id, index) => insertCalendar.run(id, "u1", `Calendar ${id.slice(4)}`, index + 1, index + 1));
	insertCalendar.run("cal:u2work", "u2", "Not yours", 1, 1);
	const { proxy, stats } = counting(database);
	return { sql, keys, env: { DB: database }, counted: { DB: proxy }, stats, database };
}

const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const call = (env, method, path, { key, body, headers = {} } = {}) => handleDavRequest(new Request(`${ORIGIN}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const propfind = (env, path, key, props, depth = "0") => call(env, "PROPFIND", path, { key, headers: { Depth: depth, ...XML }, body: `<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/"><A:prop>${props}</A:prop></A:propfind>` });
const report = (env, path, key, body) => call(env, "REPORT", path, { key, body: `<?xml version="1.0"?>${body}`, headers: { Depth: "0", ...XML } });
const NS = `xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;
const syncSince = (env, path, key, token) => report(env, path, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`);
const tokenOf = (text) => text.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
const hrefs = (text) => [...text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const ctag = async (env, path, key) => { const text = await (await propfind(env, path, key, "<CS:getctag/>")).text(); const found = text.match(/getctag>([^<]*)</)?.[1]; assert.ok(found, text); return found; };
const vevent = (uid, title) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 26//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const put = (env, path, key, body, headers = {}) => call(env, "PUT", path, { key, body, headers: { ...ICS, ...headers } });
const addEvent = (sql, id, calendarId, owner = "u1") => sql.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1793000000, 1793003600, 1, 1)").run(id, owner, calendarId, `Title ${id}`);

test("the calendar home lists default/ and a collection for each own extra calendar, never someone else's", async (t) => {
	const { env, keys } = await fixture(t);
	const response = await propfind(env, HOME, keys.u1, "<A:displayname/><A:resourcetype/><CS:getctag/>", "1");
	assert.equal(response.status, 207);
	const text = await response.text();
	assert.deepEqual(hrefs(text).filter((href) => href.startsWith(HOME)).sort(), [HOME, DEFAULT, WORK].sort());
	assert.match(text, /<D:displayname>Calendar work<\/D:displayname>/);
	assert.doesNotMatch(text, /u2work|Not yours/);
	assert.equal((text.match(/<CS:getctag>/g) ?? []).length, 2, "each calendar collection has its own CTag");
});

test("default/ serves the default calendar only and c-work/ its own events", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_a", null);
	addEvent(sql, "evt_b", "cal:work");
	assert.deepEqual(hrefs(await (await propfind(env, DEFAULT, keys.u1, "<A:getetag/>", "1")).text()).filter((href) => href.endsWith(".ics")), [`${DEFAULT}evt_a.ics`]);
	assert.deepEqual(hrefs(await (await propfind(env, WORK, keys.u1, "<A:getetag/>", "1")).text()).filter((href) => href.endsWith(".ics")), [`${WORK}evt_b.ics`]);
	assert.equal((await call(env, "GET", `${WORK}evt_b.ics`, { key: keys.u1 })).status, 200);
	assert.equal((await call(env, "GET", `${DEFAULT}evt_b.ics`, { key: keys.u1 })).status, 404);
	assert.equal((await call(env, "GET", `${WORK}evt_a.ics`, { key: keys.u1 })).status, 404);
});

test("a PUT into c-work/ files the event in that calendar, one into default/ in the default calendar", async (t) => {
	const { env, keys, sql } = await fixture(t);
	assert.equal((await put(env, `${WORK}x.ics`, keys.u1, vevent("uid-x", "In work"))).status, 201);
	assert.equal((await put(env, `${DEFAULT}y.ics`, keys.u1, vevent("uid-y", "In default"))).status, 201);
	const rows = sql.prepare("SELECT o.name, e.user_id, e.calendar_id, o.collection_id FROM dav_calendar_objects o JOIN calendar_events e ON e.id = o.id ORDER BY o.name").all();
	assert.deepEqual(rows.map((row) => [row.name, row.user_id, row.calendar_id, row.collection_id]), [["x.ics", "u1", "cal:work", "cal:work"], ["y.ics", "u1", null, "cal:u1"]]);
	assert.deepEqual(hrefs(await (await report(env, WORK, keys.u1, `<C:calendar-multiget ${NS}><A:prop><A:getetag/></A:prop><A:href>${WORK}x.ics</A:href><A:href>${DEFAULT}y.ics</A:href></C:calendar-multiget>`)).text()).filter((href) => href.endsWith(".ics")).sort(), [`${DEFAULT}y.ics`, `${WORK}x.ics`].sort());
	const text = await (await report(env, WORK, keys.u1, `<C:calendar-multiget ${NS}><A:prop><A:getetag/></A:prop><A:href>${WORK}x.ics</A:href><A:href>${WORK}y.ics</A:href></C:calendar-multiget>`)).text();
	assert.match(text, new RegExp(`<D:href>${WORK}y.ics</D:href><D:status>HTTP/1.1 404`), "a name of another collection is not found here");
});

test("a UID is unique per collection, not per user", async (t) => {
	const { env, keys } = await fixture(t);
	assert.equal((await put(env, `${DEFAULT}a.ics`, keys.u1, vevent("same-uid", "One"))).status, 201);
	assert.equal((await put(env, `${WORK}a.ics`, keys.u1, vevent("same-uid", "Copy"))).status, 201, "the same UID in another calendar is a different event");
	const clash = await put(env, `${WORK}b.ics`, keys.u1, vevent("same-uid", "Again"));
	assert.equal(clash.status, 403);
	assert.match(await clash.text(), /no-uid-conflict/);
});

test("each calendar has its own change log: an event elsewhere does not move default/'s CTag or sync", async (t) => {
	const { env, keys, sql } = await fixture(t);
	const token = tokenOf(await (await syncSince(env, DEFAULT, keys.u1, "")).text());
	const workToken = tokenOf(await (await syncSince(env, WORK, keys.u1, "")).text());
	const [defaultBefore, workBefore] = [await ctag(env, DEFAULT, keys.u1), await ctag(env, WORK, keys.u1)];
	addEvent(sql, "evt_work", "cal:work");
	assert.equal(await ctag(env, DEFAULT, keys.u1), defaultBefore);
	assert.notEqual(await ctag(env, WORK, keys.u1), workBefore);
	assert.deepEqual(hrefs(await (await syncSince(env, DEFAULT, keys.u1, token)).text()).filter((href) => href.endsWith(".ics")), []);
	assert.deepEqual(hrefs(await (await syncSince(env, WORK, keys.u1, workToken)).text()).filter((href) => href.endsWith(".ics")), [`${WORK}evt_work.ics`]);
});

test("a sync token from before each calendar had its own log is refused for default/, so the phone resyncs", async (t) => {
	const { env, keys, sql } = await fixture(t);
	const fresh = tokenOf(await (await syncSince(env, DEFAULT, keys.u1, "")).text());
	assert.equal((await syncSince(env, DEFAULT, keys.u1, fresh)).status, 207, "a token handed out now works");
	// What the state of a phone that synced before looks like: a random (version 4) epoch.
	const oldEpoch = "3f1c9a52-7b0e-4d8a-9c41-0e5b6a7d8f90";
	sql.prepare("UPDATE dav_sync_state SET epoch = ? WHERE collection_id = 'cal:u1'").run(oldEpoch);
	const refused = await syncSince(env, DEFAULT, keys.u1, `${ORIGIN}/dav/sync/cal%3Au1/${oldEpoch}/0`);
	assert.equal(refused.status, 403);
	assert.match(await refused.text(), /valid-sync-token/);
	const renewed = tokenOf(await (await syncSince(env, DEFAULT, keys.u1, "")).text());
	assert.notEqual(renewed, fresh);
	assert.equal((await syncSince(env, DEFAULT, keys.u1, renewed)).status, 207, "the renewed epoch is kept, not renewed again and again");
});

test("moving an event to another calendar removes it from default/ and adds it to c-work/, and its stored resource follows", async (t) => {
	const { env, keys, sql } = await fixture(t);
	assert.equal((await put(env, `${DEFAULT}m.ics`, keys.u1, vevent("uid-m", "Mover"))).status, 201);
	const id = sql.prepare("SELECT id FROM dav_calendar_objects WHERE name = 'm.ics'").get().id;
	const [defaultToken, workToken] = [tokenOf(await (await syncSince(env, DEFAULT, keys.u1, "")).text()), tokenOf(await (await syncSince(env, WORK, keys.u1, "")).text())];
	await getDb(env).batch(moveSeriesStatements(getDb(env), "u1", id, "cal:work"));
	assert.equal(sql.prepare("SELECT collection_id FROM dav_calendar_objects WHERE id = ?").get(id).collection_id, "cal:work");
	const gone = await (await syncSince(env, DEFAULT, keys.u1, defaultToken)).text();
	assert.match(gone, new RegExp(`<D:href>${DEFAULT}m.ics</D:href><D:status>HTTP/1.1 404`));
	const added = await (await syncSince(env, WORK, keys.u1, workToken)).text();
	assert.match(added, new RegExp(`<D:href>${WORK}m.ics</D:href>`));
	assert.doesNotMatch(added, /404 Not Found/);
	assert.equal((await call(env, "GET", `${WORK}m.ics`, { key: keys.u1 })).status, 200);
	assert.equal((await call(env, "GET", `${DEFAULT}m.ics`, { key: keys.u1 })).status, 404);
});

test("deleting a calendar removes its collection; default/'s log is untouched", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_work", "cal:work");
	const [defaultToken, before] = [tokenOf(await (await syncSince(env, DEFAULT, keys.u1, "")).text()), await ctag(env, DEFAULT, keys.u1)];
	assert.equal((await deleteCalendar(getDb(env), "u1", "cal:work")).ok, true);
	assert.equal((await propfind(env, WORK, keys.u1, "<A:displayname/>")).status, 404);
	assert.equal(await ctag(env, DEFAULT, keys.u1), before);
	assert.deepEqual(hrefs(await (await syncSince(env, DEFAULT, keys.u1, defaultToken)).text()).filter((href) => href.endsWith(".ics")), []);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_changes WHERE collection_id = 'cal:work'").get().n, 0, "the deleted calendar leaves no log behind");
	assert.deepEqual(hrefs(await (await propfind(env, HOME, keys.u1, "<A:displayname/>", "1")).text()).filter((href) => href.startsWith(HOME)), [HOME, DEFAULT]);
});

test("collection names that are not this user's calendars are 404", async (t) => {
	const { env, keys } = await fixture(t);
	for (const segment of ["c-u1", "c-u2work", "c-missing", "shared-nope", "shared-", "c-", "other", "default2", "C-work"]) {
		assert.equal((await propfind(env, `${HOME}${segment}/`, keys.u1, "<A:displayname/>")).status, 404, segment);
		assert.equal((await put(env, `${HOME}${segment}/x.ics`, keys.u1, vevent("u", "t"))).status, 404, segment);
	}
	assert.equal((await propfind(env, "/dav/calendars/u2/c-u2work/", keys.u1, "<A:displayname/>")).status, 404, "another user's home is not served");
});

test("a PROPFIND over 50 calendars with CTags stays within a small statement budget and 100 bound parameters", async (t) => {
	const extras = Array.from({ length: 49 }, (_, index) => `cal:c${index}`);
	const { counted, keys, stats } = await fixture(t, { extras });
	const response = await propfind(counted, HOME, keys.u1, "<A:displayname/><A:resourcetype/><CS:getctag/><A:sync-token/><C:calendar-description/><A:current-user-privilege-set/>", "1");
	assert.equal(response.status, 207);
	const text = await response.text();
	assert.equal((text.match(/<CS:getctag>/g) ?? []).length, 50);
	// Authentication and the listing take a handful; the positions of all 50 collections must not cost a statement or three each.
	assert.ok(stats.queries <= 20, `${stats.queries} statements`);
	assert.ok(stats.maxParams <= 100, `${stats.maxParams} bound parameters`);
});

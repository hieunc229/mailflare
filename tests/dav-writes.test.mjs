import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dav-writes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest } from "./src/lib/dav/handler.ts";
			export { clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { respondCalendar } from "./src/lib/dav/reports.ts";
			export { listCalendar, withOverrides } from "./src/lib/dav/calendar-store.ts";
			export { NS } from "./src/lib/dav/common.ts";
			export { rowsHash } from "./src/lib/dav/calendar-merge.ts";
			export { isConsistentRepeat } from "./src/lib/calendar/repeat-fields.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "dav-writes-entry.ts",
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

const { respondCalendar, listCalendar, withOverrides, NS: DAV_NS, rowsHash, isConsistentRepeat, handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";
const CAL = "/dav/calendars/u1/default/";
const BOOK = "/dav/addressbooks/u1/default/";
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

/** The database wrapped so a test can count statements and the most bound parameters one statement carried. */
function counting(database) {
	const stats = { queries: 0, maxParams: 0, maxRows: 0, beforeBatch: null, sqls: [] };
	const wrap = (statement, params = 0) => {
		const note = (result) => (Promise.resolve(result).then((rows) => void (stats.maxRows = Math.max(stats.maxRows, Array.isArray(rows) ? rows.length : Array.isArray(rows?.results) ? rows.results.length : 0)), () => {}), result);
		const count = () => (stats.queries++, (stats.maxParams = Math.max(stats.maxParams, params)));
		return {
			bind: (...values) => wrap(statement.bind(...values), values.length),
			run: () => (count(), statement.run()),
			all: () => (count(), note(statement.all())),
			raw: (options) => (count(), note(statement.raw(options))),
			first: (column) => (count(), statement.first(column)),
		};
	};
	const proxy = new Proxy(database, { get: (target, key) => (key === "prepare" ? (sql) => (stats.sqls.push(sql), wrap(target.prepare(sql))) : key === "batch" ? async (statements) => (stats.beforeBatch?.(), (stats.beforeBatch = null), target.batch(statements)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
	return { proxy, stats };
}

async function fixture(t, { calendarEnabled = true, enabled = true, limiter, writeLimiter, scopes = '["dav"]' } = {}) {
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
	if (enabled) sql.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	const key = await generateAppPassword();
	sql.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k1', 'u1', 'phone', ?, ?, ?, 'app', ?, 1)").run(key.prefix, key.hash, key.sha256, scopes);
	const { proxy, stats } = counting(database);
	return { database, sql, key, stats, env: { DB: proxy, DAV_RATE_LIMIT: limiter, DAV_WRITE_RATE_LIMIT: writeLimiter } };
}


const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const call = (env, method, path, { key, body, headers = {} } = {}) => handleDavRequest(new Request(`${ORIGIN}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const put = (env, key, name, body, headers = {}, area = CAL) => call(env, "PUT", `${area}${name}`, { key, body, headers: { "Content-Type": "text/calendar; charset=utf-8", ...headers } });
const get = (env, key, name, area = CAL) => call(env, "GET", `${area}${name}`, { key });
const del = (env, key, name, headers = {}, area = CAL) => call(env, "DELETE", `${area}${name}`, { key, headers });
const report = (env, path, key, body) => call(env, "REPORT", path, { key, body: `<?xml version="1.0"?>${body}`, headers: { Depth: "0", "Content-Type": "application/xml" } });
const NS = `xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:R="urn:ietf:params:xml:ns:carddav"`;
const syncSince = (env, key, token, area = CAL) => report(env, area, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`);
const tokenOf = (text) => text.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
const hrefs = (text) => [...text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const reset = (stats) => ((stats.queries = 0), (stats.maxParams = 0), (stats.maxRows = 0), (stats.sqls = []));

const vevent = (lines, uid = "uid-1") => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261101T000000Z\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;
const ics = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 26//EN\r\n${events.join("")}END:VCALENDAR\r\n`;
/** What a phone sends: a custom property, two alarms, an attendee with parameters. */
const phoneEvent = (uid = "uid-1", title = "Planning") =>
	ics(
		vevent(
			["DTSTART;TZID=Europe/Berlin:20261102T090000", "DTEND;TZID=Europe/Berlin:20261102T100000", `SUMMARY:${title}`, "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC", 'ATTENDEE;CN="Ann: Lee";PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:ann@example.test', "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", "DESCRIPTION:x", "END:VALARM", "BEGIN:VALARM", "ACTION:AUDIO", "TRIGGER:-PT1H", "END:VALARM"],
			uid,
		),
	);
const row = (sql, id) => sql.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id);
const rows = (sql) => sql.prepare("SELECT * FROM calendar_events ORDER BY recurrence_id IS NOT NULL, id").all();
const idOf = (sql, name) => sql.prepare("SELECT id FROM dav_calendar_objects WHERE name = ?").get(name)?.id;

test("PUT creates with If-None-Match: *, GET returns the same bytes and the same ETag", async (t) => {
	const { env, key, sql } = await fixture(t);
	const body = phoneEvent();
	const created = await put(env, key, "new.ics", body, { "If-None-Match": "*" });
	assert.equal(created.status, 201);
	const etag = created.headers.get("ETag");
	assert.match(etag, /^"\d+"$/);
	const fetched = await get(env, key, "new.ics");
	assert.equal(fetched.status, 200);
	assert.equal(await fetched.text(), body, "byte for byte, X- property and both alarms included");
	assert.equal(fetched.headers.get("ETag"), etag, "the ETag PUT returned is the one a GET shows");
	const listed = await call(env, "PROPFIND", CAL, { key, headers: { Depth: "1" } });
	assert.ok(hrefs(await listed.text()).includes(`${CAL}new.ics`));
	const id = idOf(sql, "new.ics");
	const master = row(sql, id);
	assert.deepEqual([master.title, master.dav_object_id, master.repeat, master.rrule, master.time_zone, master.reminder_minutes], ["Planning", id, "none", null, "Europe/Berlin", null], "VALARM never becomes a Mailflare reminder");
	assert.equal(master.starts_at, sec("2026-11-02T08:00:00Z"));
	assert.equal(master.attendees, '["ann@example.test"]');
	assert.equal(sql.prepare("SELECT uid FROM dav_calendar_objects WHERE id = ?").get(id).uid, "uid-1");
});

test("PUT replaces with a matching If-Match; a stale, missing or weak If-Match is 412 and changes nothing", async (t) => {
	const { env, key, sql } = await fixture(t);
	const first = await put(env, key, "e.ics", phoneEvent("uid-1", "One"), { "If-None-Match": "*" });
	const etag1 = first.headers.get("ETag");
	const second = await put(env, key, "e.ics", phoneEvent("uid-1", "Two"), { "If-Match": etag1 });
	assert.equal(second.status, 204);
	const etag2 = second.headers.get("ETag");
	assert.notEqual(etag2, etag1);
	assert.match(await (await get(env, key, "e.ics")).text(), /SUMMARY:Two/);
	const before = rows(sql);
	for (const headers of [{ "If-Match": etag1 }, { "If-Match": `W/${etag2}` }, { "If-Match": '"nope"' }, { "If-None-Match": "*" }, { "If-None-Match": etag2 }]) {
		const refused = await put(env, key, "e.ics", phoneEvent("uid-1", "Three"), headers);
		assert.equal(refused.status, 412, JSON.stringify(headers));
	}
	assert.equal((await put(env, key, "ghost.ics", phoneEvent("uid-9"), { "If-Match": etag2 })).status, 412, "If-Match on a resource that is not there");
	assert.equal((await put(env, key, "ghost.ics", phoneEvent("uid-9"), { "If-Match": "*" })).status, 412);
	assert.deepEqual(rows(sql), before);
	assert.equal((await put(env, key, "e.ics", phoneEvent("uid-1", "Four"))).status, 204, "no precondition: create or overwrite");
	assert.equal((await put(env, key, "e.ics", phoneEvent("uid-1", "Five"), { "If-Match": "*" })).status, 204);
});

test("a Mailflare-side edit is merged into the body and a stale client cannot clobber it", async (t) => {
	const { env, key, sql } = await fixture(t);
	const created = await put(env, key, "e.ics", phoneEvent(), { "If-None-Match": "*" });
	const etag = created.headers.get("ETag");
	const id = idOf(sql, "e.ics");
	const { token } = { token: tokenOf(await (await syncSince(env, key, "")).text()) };
	sql.prepare("UPDATE calendar_events SET title = 'Renamed in Mailflare', attendees = ?, updated_at = updated_at + 1 WHERE id = ?").run('["ann@example.test","new@example.test"]', id);
	const changed = await get(env, key, "e.ics");
	assert.notEqual(changed.headers.get("ETag"), etag, "the trigger moved the ETag");
	const merged = await changed.text();
	assert.match(merged, /SUMMARY:Renamed in Mailflare/);
	assert.match(merged, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/, "unmapped properties survive");
	assert.equal((merged.match(/BEGIN:VALARM/g) ?? []).length, 2, "both alarms survive");
	assert.match(merged, /ATTENDEE;CN="Ann: Lee";PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:ann@example.test/, "an unchanged guest keeps its parameters");
	assert.match(merged, /ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:new@example.test/);
	assert.match(merged, /SEQUENCE:1/);
	assert.match(merged, /DTSTART:20261102T080000Z\r\nDTEND:20261102T090000Z/, "a one-off event is written in UTC, the same instants");
	const stale = await put(env, key, "e.ics", phoneEvent("uid-1", "Stale phone edit"), { "If-Match": etag });
	assert.equal(stale.status, 412);
	assert.equal(row(sql, id).title, "Renamed in Mailflare");
	assert.ok(hrefs(await (await syncSince(env, key, token)).text()).includes(`${CAL}e.ics`), "sync shows the Mailflare-side change");
});

const changeRows = (sql) => sql.prepare("SELECT count(*) AS n FROM dav_changes").get().n;
const guardRows = (sql) => sql.prepare("SELECT count(*) AS n FROM dav_sync_state WHERE collection_id LIKE 'guard:%'").get().n;

test("a Mailflare-side edit between the read and the write makes the PUT 412 and overwrites nothing", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	const series = ics(
		vevent(["DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY", "SUMMARY:Daily"]),
		vevent(["RECURRENCE-ID:20261105T090000Z", "DTSTART:20261105T100000Z", "SUMMARY:Moved"]),
	);
	const created = await put(env, key, "e.ics", series);
	assert.equal(created.status, 201);
	const id = idOf(sql, "e.ics");
	assert.equal(guardRows(sql), 0, "the guard leaves no rows behind");
	const edit = () => sql.prepare("UPDATE calendar_events SET title = 'Edited in Mailflare', updated_at = updated_at + 1 WHERE id = ?").run(id);
	for (const headers of [{ "If-Match": created.headers.get("ETag") }, {}]) {
		stats.beforeBatch = edit;
		const before = rows(sql);
		const changes = changeRows(sql);
		const refused = await put(env, key, "e.ics", ics(vevent(["DTSTART:20261102T090000Z", "SUMMARY:Phone overwrite"])), headers);
		assert.equal(refused.status, 412, JSON.stringify(headers));
		assert.equal(row(sql, id).title, "Edited in Mailflare");
		assert.equal(rows(sql).length, before.length, "the override rows were not touched");
		assert.equal(sql.prepare("SELECT body FROM dav_calendar_objects WHERE id = ?").get(id).body, series, "the stored body is the one before");
		assert.equal(changeRows(sql), changes + 1, "only the edit is in the change log");
		assert.equal(guardRows(sql), 0);
		await get(env, key, "e.ics");
		sql.prepare("UPDATE calendar_events SET title = 'Daily', updated_at = updated_at + 1 WHERE id = ?").run(id);
	}
});

test("a resource deleted between the read and the write is 412 and leaves no orphan rows", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	const series = (title) => ics(vevent(["DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY", `SUMMARY:${title}`]), vevent(["RECURRENCE-ID:20261105T090000Z", "DTSTART:20261105T100000Z", "SUMMARY:Moved"]));
	await put(env, key, "e.ics", series("One"));
	const id = idOf(sql, "e.ics");
	stats.beforeBatch = () => sql.prepare("DELETE FROM calendar_events WHERE id = ? OR dav_object_id = ?").run(id, id);
	const refused = await put(env, key, "e.ics", series("Two"));
	assert.equal(refused.status, 412);
	assert.equal(rows(sql).length, 0, "no master and no orphaned override");
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_calendar_objects").get().n, 0);
	assert.equal(guardRows(sql), 0);
	assert.equal((await put(env, key, "e.ics", series("Three"), { "If-None-Match": "*" })).status, 201, "the name is free again");
});

test("a native event without change rows is guarded by its update time", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	sql.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('n1', 'u1', 'Native', 100, 200, 1, 5)").run();
	sql.prepare("DELETE FROM dav_changes").run();
	stats.beforeBatch = () => sql.prepare("UPDATE calendar_events SET title = 'Edited', updated_at = 6 WHERE id = 'n1'").run();
	const refused = await put(env, key, "n1.ics", phoneEvent("n1@mailflare"), { "If-Match": '"t5"' });
	assert.equal(refused.status, 412);
	assert.equal(row(sql, "n1").title, "Edited");
});

test("DELETE of a resource edited meanwhile is 412 and removes nothing", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	const etag = (await put(env, key, "d.ics", phoneEvent())).headers.get("ETag");
	const id = idOf(sql, "d.ics");
	stats.beforeBatch = () => sql.prepare("UPDATE calendar_events SET title = 'Edited', updated_at = updated_at + 1 WHERE id = ?").run(id);
	assert.equal((await del(env, key, "d.ics", { "If-Match": etag })).status, 412);
	assert.equal(row(sql, id).title, "Edited");
	assert.equal(guardRows(sql), 0);
	assert.equal((await del(env, key, "d.ics", { "If-Match": (await get(env, key, "d.ics")).headers.get("ETag") })).status, 204);
});

test("a UID that belongs to another resource is 403 no-uid-conflict with that resource's href", async (t) => {
	const { env, key, sql } = await fixture(t);
	await put(env, key, "a.ics", phoneEvent("same"));
	const clash = await put(env, key, "b.ics", phoneEvent("same"));
	assert.equal(clash.status, 403);
	const text = await clash.text();
	assert.match(text, /<C:no-uid-conflict><D:href>\/dav\/calendars\/u1\/default\/a\.ics<\/D:href><\/C:no-uid-conflict>/);
	assert.equal((await put(env, key, "a.ics", phoneEvent("same", "Same resource again"))).status, 204);
	sql.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('native1', 'u1', 'Native', 100, 200, 1, 1)").run();
	const nativeClash = await put(env, key, "c.ics", phoneEvent("native1@mailflare"));
	assert.equal(nativeClash.status, 403);
	assert.match(await nativeClash.text(), /<D:href>\/dav\/calendars\/u1\/default\/native1\.ics<\/D:href>/);
	const other = await put(env, key, "native1.ics", phoneEvent("native1@mailflare", "Native, edited by a phone"));
	assert.equal(other.status, 204, "a native event can be updated through its own name");
	assert.equal(row(sql, "native1").title, "Native, edited by a phone");
	assert.equal(row(sql, "native1").dav_object_id, "native1");
});

test("what is refused: components, METHOD, size, type, name, UID length", async (t) => {
	const { env, key, sql } = await fixture(t);
	const refused = async (promise, status, pattern) => {
		const response = await promise;
		assert.equal(response.status, status);
		if (pattern) assert.match(await response.text(), pattern);
	};
	await refused(put(env, key, "t.ics", ics("BEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\n")), 403, /<C:supported-calendar-component\/>/);
	await refused(put(env, key, "m.ics", phoneEvent().replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:REQUEST")), 403, /<C:valid-calendar-object-resource\/>/);
	await refused(put(env, key, "g.ics", "not a calendar"), 403, /<C:valid-calendar-object-resource\/>/);
	await refused(put(env, key, "u.ics", phoneEvent("x".repeat(192))), 403, /<C:valid-calendar-object-resource\/>/);
	await refused(put(env, key, "big.ics", "x".repeat(1_048_577)), 413);
	await refused(put(env, key, "big.ics", "x", { "Content-Length": "2000000" }), 413);
	await refused(put(env, key, "ty.ics", phoneEvent(), { "Content-Type": "application/json" }), 415);
	await refused(call(env, "PUT", `${CAL}ok.ics`, { key, body: phoneEvent() }), 415);
	await refused(put(env, key, "bad name.ics", phoneEvent()), 400);
	await refused(put(env, key, `${"a".repeat(201)}.ics`, phoneEvent()), 400);
	await refused(put(env, key, "x.txt", phoneEvent()), 400);
	await refused(call(env, "PUT", CAL, { key, body: phoneEvent(), headers: { "Content-Type": "text/calendar" } }), 405);
	await refused(call(env, "PUT", "/dav/calendars/u2/default/x.ics", { key, body: phoneEvent(), headers: { "Content-Type": "text/calendar" } }), 404);
	const streamed = new Request(`${ORIGIN}${CAL}s.ics`, { method: "PUT", body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(700_000)); c.enqueue(new Uint8Array(700_000)); c.close(); } }), duplex: "half", headers: { Authorization: basic(key.fullKey), "Content-Type": "text/calendar" } });
	await refused(handleDavRequest(streamed, env), 413);
	assert.equal(rows(sql).length, 0, "nothing was written by any refused request");
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_calendar_objects").get().n, 0);
});

test("a recurring event with overrides: rows, exact bytes, replacement and DELETE of the whole resource", async (t) => {
	const { env, key, sql } = await fixture(t);
	const series = ics(
		vevent(["DTSTART;TZID=Europe/Berlin:20261102T090000", "DTEND;TZID=Europe/Berlin:20261102T100000", "RRULE:FREQ=WEEKLY;INTERVAL=2", "EXDATE;TZID=Europe/Berlin:20261116T090000", "SUMMARY:Biweekly"]),
		vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261130T090000", "DTSTART;TZID=Europe/Berlin:20261130T130000", "DTEND;TZID=Europe/Berlin:20261130T140000", "SUMMARY:Moved"]),
	);
	assert.equal((await put(env, key, "s.ics", series)).status, 201);
	const id = idOf(sql, "s.ics");
	const all = rows(sql);
	assert.equal(all.length, 2);
	const master = all.find((r) => r.id === id);
	const override = all.find((r) => r.id !== id);
	assert.deepEqual([master.repeat, master.rrule, master.repeat_days, master.repeat_anchor_day, master.repeat_until], ["custom", "FREQ=WEEKLY;INTERVAL=2", "[]", null, null]);
	assert.deepEqual([override.dav_object_id, override.recurrence_id, override.repeat, override.rrule, override.title], [id, sec("2026-11-30T08:00:00Z"), "none", null, "Moved"]);
	assert.equal(JSON.parse(master.excluded_occurrences).length, 2, "the EXDATE and the overridden instant");
	for (const r of all) assert.equal(isConsistentRepeat({ repeat: r.repeat, rrule: r.rrule, repeatDays: r.repeat_days, repeatAnchorDay: r.repeat_anchor_day, repeatUntil: r.repeat_until === null ? null : new Date(r.repeat_until * 1000) }), true);
	assert.equal(await (await get(env, key, "s.ics")).text(), series);

	const shorter = ics(vevent(["DTSTART;TZID=Europe/Berlin:20261102T090000", "DTEND;TZID=Europe/Berlin:20261102T100000", "RRULE:FREQ=WEEKLY", "SUMMARY:Weekly"]));
	assert.equal((await put(env, key, "s.ics", shorter)).status, 204);
	assert.equal(rows(sql).length, 1, "the override the client dropped is gone");
	assert.deepEqual([rows(sql)[0].repeat, rows(sql)[0].rrule], ["weekly", null], "back to the legacy columns when exact");
	assert.equal((await put(env, key, "s.ics", series)).status, 204);
	assert.equal(rows(sql).length, 2);
	const etag = (await get(env, key, "s.ics")).headers.get("ETag");
	const first = tokenOf(await (await syncSince(env, key, "")).text());
	assert.equal((await del(env, key, "s.ics", { "If-Match": '"0"' })).status, 412);
	assert.equal(rows(sql).length, 2);
	assert.equal((await del(env, key, "s.ics", { "If-Match": etag })).status, 204);
	assert.equal(rows(sql).length, 0);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_calendar_objects").get().n, 0);
	assert.equal((await get(env, key, "s.ics")).status, 404);
	assert.equal((await del(env, key, "s.ics")).status, 404);
	const gone = await (await syncSince(env, key, first)).text();
	assert.match(gone, new RegExp(`<D:href>${CAL}s\\.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status>`), "sync shows it gone under the name the phone used");
	assert.doesNotMatch(gone, /evt_/);
});

test("a cancelled or declined event is stored, hidden, reported gone under its name, and visible again when re-sent", async (t) => {
	const { env, key } = await fixture(t);
	await put(env, key, "c.ics", phoneEvent("uid-c"));
	const token = tokenOf(await (await syncSince(env, key, "")).text());
	const cancelled = await put(env, key, "c.ics", ics(vevent(["DTSTART:20261102T090000Z", "STATUS:CANCELLED", "SUMMARY:Off"], "uid-c")));
	assert.equal(cancelled.status, 204);
	assert.equal((await get(env, key, "c.ics")).status, 404, "hidden events are not served");
	assert.match(await (await syncSince(env, key, token)).text(), new RegExp(`<D:href>${CAL}c\\.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status>`));
	assert.equal((await put(env, key, "c.ics", phoneEvent("uid-c"), { "If-None-Match": "*" })).status, 412, "the name is taken even while hidden");
	assert.equal((await put(env, key, "c.ics", phoneEvent("uid-c", "Back"))).status, 204);
	assert.match(await (await get(env, key, "c.ics")).text(), /SUMMARY:Back/);
});

test("a PUT stays under 40 statements and 100 bound parameters, even at the largest accepted resource", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	const overrides = Array.from({ length: 39 }, (_, i) => vevent([`RECURRENCE-ID:2027${String(1 + (i % 12)).padStart(2, "0")}${String(2 + Math.floor(i / 12)).padStart(2, "0")}T090000Z`, `DTSTART:2027${String(1 + (i % 12)).padStart(2, "0")}${String(2 + Math.floor(i / 12)).padStart(2, "0")}T100000Z`, `SUMMARY:Moved ${i}`]));
	const big = ics(vevent(["DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY", "SUMMARY:Daily"]), ...overrides);
	for (const [label, headers] of [["create", {}], ["replace", {}]]) {
		reset(stats);
		const response = await put(env, key, "big.ics", big, headers);
		assert.ok([201, 204].includes(response.status), `${label}: ${response.status}`);
		assert.ok(stats.queries <= 40, `${label}: ${stats.queries} statements`);
		assert.ok(stats.maxParams < 100, `${label}: ${stats.maxParams} parameters`);
	}
	assert.equal(rows(sql).length, 40);
	reset(stats);
	assert.equal((await del(env, key, "big.ics")).status, 204);
	assert.ok(stats.queries <= 40, `delete: ${stats.queries} statements`);
	const tooMany = ics(vevent(["DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY"]), ...overrides, vevent(["RECURRENCE-ID:20281001T090000Z", "DTSTART:20281001T100000Z"]));
	assert.equal((await put(env, key, "big.ics", tooMany)).status, 403);
});

test("nothing in a body is fetched, and an alarm sets no Mailflare reminder", async (t) => {
	const { env, key, sql } = await fixture(t);
	const real = globalThis.fetch;
	globalThis.fetch = () => {
		throw new Error("DAV must not fetch");
	};
	try {
		const body = ics("BEGIN:VTIMEZONE\r\nTZID:Mine\r\nTZURL:http://tz.invalid/z\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n", vevent(["DTSTART;TZID=Mine:20261102T090000", "ATTACH:http://attach.invalid/x", "URL:http://url.invalid/", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT5M", "END:VALARM"]));
		assert.equal((await put(env, key, "f.ics", body)).status, 201);
		assert.equal(await (await get(env, key, "f.ics")).text(), body);
	} finally {
		globalThis.fetch = real;
	}
	assert.equal(rows(sql)[0].reminder_minutes, null);
});

test("a reminder set in Mailflare reaches the client as the first alarm, the client's other alarms stay", async (t) => {
	const { env, key, sql } = await fixture(t);
	await put(env, key, "r.ics", phoneEvent());
	sql.prepare("UPDATE calendar_events SET reminder_minutes = 30, updated_at = updated_at + 1").run();
	const merged = await (await get(env, key, "r.ics")).text();
	assert.match(merged, /TRIGGER:-PT30M/);
	assert.doesNotMatch(merged, /TRIGGER:-PT10M/);
	assert.match(merged, /TRIGGER:-PT1H/);
});

test("the gate: switch off, scope, calendar off, wrong user and the write budget change nothing", async (t) => {
	const off = await fixture(t, { enabled: false });
	assert.equal((await put(off.env, off.key, "a.ics", phoneEvent())).status, 404);
	assert.equal((await del(off.env, off.key, "a.ics")).status, 404);
	assert.equal(rows(off.sql).length, 0);
	const scoped = await fixture(t, { scopes: '["jmap"]' });
	assert.equal((await put(scoped.env, scoped.key, "a.ics", phoneEvent())).status, 401);
	assert.equal(rows(scoped.sql).length, 0);
	const noCalendar = await fixture(t, { calendarEnabled: false });
	assert.equal((await put(noCalendar.env, noCalendar.key, "a.ics", phoneEvent())).status, 403);
	assert.equal(rows(noCalendar.sql).length, 0);
	const seen = [];
	const readKeys = [];
	const limited = await fixture(t, { limiter: { limit: async ({ key: k }) => (readKeys.push(k), { success: true }) }, writeLimiter: { limit: async ({ key: k }) => (seen.push(k), { success: false }) } });
	assert.equal((await put(limited.env, limited.key, "a.ics", phoneEvent())).status, 503);
	assert.ok(seen.includes("dav-write:u1"), "writes spend their own limiter");
	assert.ok(!readKeys.some((k) => k.startsWith("dav-write:")), "and not the request limiter");
	assert.equal((await get(limited.env, limited.key, "a.ics")).status, 404, "reads do not spend the write budget");
	assert.equal(rows(limited.sql).length, 0);
	assert.equal((await del(limited.env, limited.key, "a.ics")).status, 503);
});

test("a moved occurrence is never also an EXDATE after a Mailflare-side edit", async (t) => {
	const { env, key, sql } = await fixture(t);
	const series = ics(
		vevent(["DTSTART;TZID=Europe/Berlin:20261102T090000", "DTEND;TZID=Europe/Berlin:20261102T100000", "RRULE:FREQ=WEEKLY;INTERVAL=2", "EXDATE;TZID=Europe/Berlin:20261116T090000", "SUMMARY:Biweekly"]),
		vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261130T090000", "DTSTART;TZID=Europe/Berlin:20261130T130000", "DTEND;TZID=Europe/Berlin:20261130T140000", "SUMMARY:Moved"]),
	);
	await put(env, key, "s.ics", series);
	sql.prepare("UPDATE calendar_events SET title = 'Renamed', updated_at = updated_at + 1 WHERE id = ?").run(idOf(sql, "s.ics"));
	const merged = await (await get(env, key, "s.ics")).text();
	assert.match(merged, /SUMMARY:Renamed/);
	assert.match(merged, /RECURRENCE-ID;TZID=Europe\/Berlin:20261130T090000/);
	assert.match(merged, /EXDATE[^\r\n]*20261116/, "the client's own exclusion stays");
	assert.doesNotMatch(merged, /EXDATE[^\r\n]*(20261130T080000Z|20261130T090000)/, "the overridden instant is not excluded as well");
});

test("a rule the rows cannot hold survives a Mailflare-side rename", async (t) => {
	const { env, key, sql } = await fixture(t);
	const body = ics(vevent(["DTSTART;TZID=Europe/Berlin:20261102T090000", "DTEND;TZID=Europe/Berlin:20261102T100000", "RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO", "EXDATE;TZID=Europe/Berlin:20270517T090000", "RDATE;TZID=Europe/Berlin:20261225T090000", "SUMMARY:Odd rule"]));
	await put(env, key, "w.ics", body);
	const id = idOf(sql, "w.ics");
	assert.equal(row(sql, id).repeat, "none", "the rows cannot express it");
	sql.prepare("UPDATE calendar_events SET title = 'Renamed', updated_at = updated_at + 1 WHERE id = ?").run(id);
	const merged = await (await get(env, key, "w.ics")).text();
	assert.match(merged, /SUMMARY:Renamed/);
	assert.match(merged, /RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO/);
	assert.equal((merged.match(/EXDATE/g) ?? []).length, 1, "the client's exclusion once, not twice");
	assert.match(merged, /RDATE/);
});

test("a TZID the system does not know cannot break a read of a merged resource", async (t) => {
	const { env, key, sql } = await fixture(t);
	const body = ics(vevent(["DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "SUMMARY:Zoned", "X-CLIENT;TZID=Not/A_Zone:20261102T090000"]));
	assert.equal((await put(env, key, "z.ics", body)).status, 201);
	sql.prepare("UPDATE calendar_events SET title = 'Renamed', updated_at = updated_at + 1 WHERE id = ?").run(idOf(sql, "z.ics"));
	const warn = console.warn;
	const warnings = [];
	console.warn = (...args) => void warnings.push(args);
	try {
		const fetched = await get(env, key, "z.ics");
		assert.equal(fetched.status, 200);
		assert.match(await fetched.text(), /SUMMARY:Renamed/);
		const multiget = await report(env, CAL, key, `<C:calendar-multiget ${NS}><A:prop><A:getetag/><C:calendar-data/></A:prop><A:href>${CAL}z.ics</A:href></C:calendar-multiget>`);
		assert.equal(multiget.status, 207);
		assert.match(await multiget.text(), /SUMMARY:Renamed/);
		await get(env, key, "z.ics");
	} finally {
		console.warn = warn;
	}
});

const MiB = 1024 * 1024;
/** A stored resource of `size` bytes without writing the bytes: quotas count the size column. */
const seedObject = (sql, id, name, size, user = "u1") => {
	sql.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, dav_object_id, created_at, updated_at) VALUES (?, ?, 'Seed', 100, 200, ?, 1, 1)").run(id, user, id);
	sql.prepare("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, body, rows_hash, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'x', 'h', ?, 1, 1)").run(id, user, `cal:${user}`, name, `seed-${id}`, size);
};

test("calendar resources are capped at 50 MB in total per user: over it is 507, shrinking and other users are not affected", async (t) => {
	const { env, key, sql } = await fixture(t);
	const body = phoneEvent("fresh");
	seedObject(sql, "big1", "big1.ics", 50 * MiB - body.length + 1);
	assert.equal((await put(env, key, "fresh.ics", body)).status, 507, "one byte over");
	assert.equal(rows(sql).length, 1);
	seedObject(sql, "other", "other.ics", 50 * MiB, "u2");
	sql.prepare("UPDATE dav_calendar_objects SET size = ? WHERE id = 'big1'").run(50 * MiB - body.length);
	assert.equal((await put(env, key, "fresh.ics", body)).status, 201, "exactly at the cap, and the other user's 50 MB do not count");
	assert.equal((await put(env, key, "fresh.ics", phoneEvent("fresh", "A longer title than before"))).status, 507, "growing a resource at the cap");
	assert.equal((await put(env, key, "big1.ics", phoneEvent("seed-big1"))).status, 204, "replacing a big resource with a small one frees space");
	assert.equal((await put(env, key, "fresh.ics", phoneEvent("fresh", "A longer title than before"))).status, 204);
	assert.equal((await del(env, key, "fresh.ics")).status, 204, "a delete is never refused for space");
});

test("a PUT onto an existing resource cannot change its UID", async (t) => {
	const { env, key, sql } = await fixture(t);
	await put(env, key, "a.ics", phoneEvent("uid-a", "One"));
	const refused = await put(env, key, "a.ics", phoneEvent("uid-other", "Two"));
	assert.equal(refused.status, 403);
	assert.match(await refused.text(), /<C:no-uid-conflict><D:href>\/dav\/calendars\/u1\/default\/a\.ics<\/D:href><\/C:no-uid-conflict>/);
	assert.equal(rows(sql)[0].title, "One");
	assert.equal(sql.prepare("SELECT uid FROM dav_calendar_objects").get().uid, "uid-a");
});

test("the UID of a hidden resource can be re-sent under a new name: the new name takes over", async (t) => {
	const { env, key, sql } = await fixture(t);
	await put(env, key, "old.ics", phoneEvent("uid-c"));
	await put(env, key, "old.ics", ics(vevent(["DTSTART:20261102T090000Z", "STATUS:CANCELLED", "SUMMARY:Off"], "uid-c")));
	assert.equal((await get(env, key, "old.ics")).status, 404);
	const moved = await put(env, key, "new.ics", phoneEvent("uid-c", "Back"), { "If-None-Match": "*" });
	assert.equal(moved.status, 201);
	assert.match(await (await get(env, key, "new.ics")).text(), /SUMMARY:Back/);
	assert.equal((await get(env, key, "old.ics")).status, 404);
	assert.deepEqual(sql.prepare("SELECT name FROM dav_calendar_objects").all().map((r) => r.name), ["new.ics"]);
	assert.equal(rows(sql).length, 1);
	const clash = await put(env, key, "third.ics", phoneEvent("uid-c"));
	assert.equal(clash.status, 403, "a visible resource still holds its UID");
	assert.match(await clash.text(), /new\.ics/);
});

test("a getetag-only calendar-query loads no bodies, and a multiget loads bodies in chunks of at most 8 MB", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	for (const name of ["a", "b", "c", "d"]) await put(env, key, `${name}.ics`, phoneEvent(`uid-${name}`));
	sql.prepare("UPDATE dav_calendar_objects SET size = ?").run(5 * MiB);
	const bodyReads = () => stats.sqls.filter((text) => /"body"/.test(text) && /dav_calendar_objects/.test(text));
	reset(stats);
	const etags = await report(env, CAL, key, `<C:calendar-query ${NS}><A:prop><A:getetag/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`);
	assert.equal(etags.status, 207);
	assert.equal(hrefs(await etags.text()).length, 4);
	assert.equal(bodyReads().length, 0, "no stored body was read");
	reset(stats);
	const multiget = await report(env, CAL, key, `<C:calendar-multiget ${NS}><A:prop><A:getetag/><C:calendar-data/></A:prop>${["a", "b", "c", "d"].map((n) => `<A:href>${CAL}${n}.ics</A:href>`).join("")}</C:calendar-multiget>`);
	const text = await multiget.text();
	assert.equal((text.match(/BEGIN:VCALENDAR/g) ?? []).length, 4);
	assert.equal(bodyReads().length, 4, "5 MB each: one resource per chunk of at most 8 MB");
	reset(stats);
	const query = await report(env, CAL, key, `<C:calendar-query ${NS}><A:prop><A:getetag/><C:calendar-data/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`);
	assert.equal(((await query.text()).match(/BEGIN:VCALENDAR/g) ?? []).length, 4);
	assert.equal(bodyReads().length, 4, "a query with calendar-data is chunked the same way");
});

test("a streamed calendar response drops each group's stored bodies once it is sent", async (t) => {
	const { env, key, sql } = await fixture(t);
	for (const name of ["a", "b", "c"]) await put(env, key, `${name}.ics`, phoneEvent(`uid-${name}`));
	sql.prepare("UPDATE dav_calendar_objects SET size = ?").run(5 * MiB);
	const resources = await withOverrides(env, "u1", await listCalendar(env, "u1", 100));
	assert.equal(resources.length, 3);
	const wanted = { ns: DAV_NS.dav, name: "prop", text: "", attrs: {}, children: [{ ns: DAV_NS.caldav, name: "calendar-data", text: "", attrs: {}, children: [] }] };
	const held = () => resources.filter((resource) => resource.stored).length;
	const stream = respondCalendar({ env, userId: "u1", timeZone: "Europe/Berlin" }, resources, new Map(), wanted);
	const peaks = [];
	for await (const part of stream) {
		assert.equal(part.length, 1, "5 MB each: one resource per group");
		peaks.push(held());
	}
	assert.deepEqual(peaks, [1, 1, 1], "only the group being sent holds a body");
	assert.equal(held(), 0, "nothing is kept after the last group");
});

test("write privileges are advertised on both collections and the methods are allowed", async (t) => {
	const { env, key } = await fixture(t);
	const options = await call(env, "OPTIONS", CAL);
	assert.match(options.headers.get("Allow"), /PUT/);
	assert.match(options.headers.get("Allow"), /DELETE/);
	const response = await call(env, "PROPFIND", CAL, { key, body: `<?xml version="1.0"?><A:propfind xmlns:A="DAV:"><A:prop><A:current-user-privilege-set/></A:prop></A:propfind>`, headers: { Depth: "0", "Content-Type": "application/xml" } });
	const text = await response.text();
	for (const privilege of ["read", "write-content", "bind", "unbind"]) assert.match(text, new RegExp(`<D:privilege><D:${privilege}/></D:privilege>`), privilege);
	assert.equal((await del(env, key, "", {})).status, 403, "a collection cannot be deleted");
});

test("the stored hash follows the rows: the same rows hash the same, any projected change does not", async (t) => {
	const { env, key, sql } = await fixture(t);
	await put(env, key, "h.ics", phoneEvent());
	const id = idOf(sql, "h.ics");
	const stored = sql.prepare("SELECT rows_hash FROM dav_calendar_objects WHERE id = ?").get(id).rows_hash;
	assert.match(stored, /^[0-9a-f]{64}$/);
	const camel = (r) => ({ ...r, repeatDays: r.repeat_days, repeatAnchorDay: r.repeat_anchor_day, repeatUntil: r.repeat_until === null ? null : new Date(r.repeat_until * 1000), excludedOccurrences: r.excluded_occurrences, timeZone: r.time_zone, startsAt: new Date(r.starts_at * 1000), endsAt: new Date(r.ends_at * 1000), attendeeResponses: r.attendee_responses, allDay: Boolean(r.all_day), reminderMinutes: r.reminder_minutes, responseStatus: r.response_status, recurrenceId: null });
	assert.equal(await rowsHash(camel(row(sql, id)), []), stored);
	assert.notEqual(await rowsHash({ ...camel(row(sql, id)), title: "x" }, []), stored);
});

test("merging a series: overrides are rebuilt keeping the client's lines, dropped rows go, a new zone gets its VTIMEZONE", async (t) => {
	const { env, key, sql } = await fixture(t);
	const series = ics(
		vevent(["DTSTART;TZID=Europe/Berlin:20261102T090000", "DTEND;TZID=Europe/Berlin:20261102T100000", "RRULE:FREQ=WEEKLY;INTERVAL=2", "SUMMARY:Biweekly", "X-SERIES:kept"]),
		vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261130T090000", "DTSTART;TZID=Europe/Berlin:20261130T130000", "DTEND;TZID=Europe/Berlin:20261130T140000", "SUMMARY:Moved", "X-OVERRIDE:kept"]),
		vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261214T090000", "DTSTART;TZID=Europe/Berlin:20261214T110000", "DTEND;TZID=Europe/Berlin:20261214T120000", "SUMMARY:Also moved"]),
	);
	await put(env, key, "s.ics", series);
	const id = idOf(sql, "s.ics");
	sql.prepare("UPDATE calendar_events SET title = 'Renamed override', updated_at = updated_at + 1 WHERE title = 'Moved'").run();
	sql.prepare("DELETE FROM calendar_events WHERE title = 'Also moved'").run();
	sql.prepare("UPDATE calendar_events SET title = 'Renamed series', updated_at = updated_at + 1 WHERE id = ?").run(id);
	const merged = await (await get(env, key, "s.ics")).text();
	assert.match(merged, /SUMMARY:Renamed series/);
	assert.match(merged, /X-SERIES:kept/);
	assert.match(merged, /RRULE:FREQ=WEEKLY;INTERVAL=2/);
	assert.match(merged, /SUMMARY:Renamed override/);
	assert.match(merged, /X-OVERRIDE:kept/, "the override keeps the client's own lines, matched by RECURRENCE-ID");
	assert.match(merged, /RECURRENCE-ID;TZID=Europe\/Berlin:20261130T090000/);
	assert.doesNotMatch(merged, /Also moved|20261214T090000\r\nDTSTART/, "an override whose row is gone is dropped");
	assert.equal((merged.match(/BEGIN:VEVENT/g) ?? []).length, 2);
	assert.equal((merged.match(/BEGIN:VTIMEZONE/g) ?? []).length, 1, "the zone the rows now use has a VTIMEZONE");
	assert.match(merged, /TZID:Europe\/Berlin/);
	assert.equal(await (await get(env, key, "s.ics")).text(), merged, "reads of the same rows are identical");
});

const vcard = (lines = [], { version = "3.0", uid = "card-1" } = {}) => `BEGIN:VCARD\r\nVERSION:${version}\r\nUID:${uid}\r\n${lines.join("\r\n")}${lines.length ? "\r\n" : ""}END:VCARD\r\n`;
const putCard = (env, key, name, body, headers = {}) => put(env, key, name, body, { "Content-Type": "text/vcard; charset=utf-8", ...headers }, BOOK);
const card = (sql, name) => sql.prepare("SELECT * FROM dav_cards WHERE name = ?").get(name);

test("a card is PUT, served byte for byte and kept exactly, with its name, e-mail addresses and version indexed", async (t) => {
	const { env, key, sql } = await fixture(t);
	const body = vcard(["FN:Ann Lee", "N:Lee;Ann;;;", "item1.EMAIL;TYPE=INTERNET:Ann@Example.test", "EMAIL:ann@work.test", "TEL;TYPE=CELL:+1 555 0100", "PHOTO;ENCODING=b;TYPE=JPEG:AAAA", "X-CUSTOM:kept"]);
	const created = await putCard(env, key, "ann.vcf", body, { "If-None-Match": "*" });
	assert.equal(created.status, 201);
	const etag = created.headers.get("ETag");
	const fetched = await get(env, key, "ann.vcf", BOOK);
	assert.equal(await fetched.text(), body);
	assert.equal(fetched.headers.get("ETag"), etag);
	assert.match(fetched.headers.get("Content-Type"), /^text\/vcard/);
	const stored = card(sql, "ann.vcf");
	assert.deepEqual([stored.uid, stored.version, stored.fn, stored.emails, stored.size, stored.collection_id, stored.user_id], ["card-1", "3.0", "Ann Lee", '["ann@example.test","ann@work.test"]', body.length, "card:u1", "u1"]);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM contacts WHERE dav_card_id = ?").get(stored.id).n, 2, "both addresses are mirrored into contacts (tests/dav-contacts.test.mjs)");
	const four = await putCard(env, key, "four.vcf", vcard(["FN:Four", "EMAIL:four@example.test"], { version: "4.0", uid: "card-4" }));
	assert.equal(four.status, 201);
	assert.equal(card(sql, "four.vcf").version, "4.0");
	assert.equal((await putCard(env, key, "x.vcf", vcard(["FN:X"], { uid: "card-x" }), { "Content-Type": "text/x-vcard" })).status, 201);
});

test("the name falls back to N, then the first address; addresses are capped and checked", async (t) => {
	const { env, key, sql } = await fixture(t);
	await putCard(env, key, "n.vcf", vcard(["N:Lee;Ann;;;"], { uid: "n" }));
	await putCard(env, key, "e.vcf", vcard(["EMAIL:only@example.test"], { uid: "e" }));
	await putCard(env, key, "none.vcf", vcard([], { uid: "none" }));
	assert.deepEqual(["n.vcf", "e.vcf", "none.vcf"].map((name) => card(sql, name).fn), ["Ann Lee", "only@example.test", ""]);
	const many = Array.from({ length: 30 }, (_, i) => `EMAIL:a${i}@example.test`);
	await putCard(env, key, "many.vcf", vcard(["FN:Many", "EMAIL:not an address", "EMAIL:mailto:Ok@Example.test", `EMAIL:${"x".repeat(400)}@example.test`, ...many], { uid: "many" }));
	const emails = JSON.parse(card(sql, "many.vcf").emails);
	assert.equal(emails.length, 20);
	assert.equal(emails[0], "ok@example.test");
	assert.ok(emails.every((address) => /^[^\s@]+@[^\s@]+$/.test(address)));
});

test("rejects malformed addresses on a card", async (t) => {
	const { env, key, sql } = await fixture(t);
	const exact = `${"a".repeat(300)}@example.test`;
	const over = `${"a".repeat(320)}@example.test`;
	await putCard(env, key, "o.vcf", vcard(["FN:O", `EMAIL:${over}`, `EMAIL:${exact}`, "EMAIL:a@b@example.test", "EMAIL:@example.test", "EMAIL:a@", "EMAIL:a,b@example.test", "EMAIL:ok@example.test"], { uid: "o" }));
	assert.deepEqual(JSON.parse(card(sql, "o.vcf").emails), [exact, "ok@example.test"]);
});

test("a card PUT follows If-Match and If-None-Match, and a UID taken by another card is 403 no-uid-conflict", async (t) => {
	const { env, key, sql } = await fixture(t);
	const first = await putCard(env, key, "a.vcf", vcard(["FN:One"]), { "If-None-Match": "*" });
	const etag1 = first.headers.get("ETag");
	assert.equal((await putCard(env, key, "a.vcf", vcard(["FN:Two"]), { "If-None-Match": "*" })).status, 412);
	const second = await putCard(env, key, "a.vcf", vcard(["FN:Two"]), { "If-Match": etag1 });
	assert.equal(second.status, 204);
	assert.notEqual(second.headers.get("ETag"), etag1);
	assert.equal(card(sql, "a.vcf").fn, "Two");
	assert.equal((await putCard(env, key, "a.vcf", vcard(["FN:Stale"]), { "If-Match": etag1 })).status, 412);
	assert.equal(card(sql, "a.vcf").fn, "Two");
	assert.equal((await putCard(env, key, "ghost.vcf", vcard(["FN:G"], { uid: "g" }), { "If-Match": "*" })).status, 412);
	const clash = await putCard(env, key, "b.vcf", vcard(["FN:Clash"]));
	assert.equal(clash.status, 403);
	assert.match(await clash.text(), /<CR:no-uid-conflict><D:href>\/dav\/addressbooks\/u1\/default\/a\.vcf<\/D:href><\/CR:no-uid-conflict>/);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 1);
});

test("a card edited or deleted between the read and the write is 412 and nothing is overwritten", async (t) => {
	const { env, key, sql, stats } = await fixture(t);
	const etag = (await putCard(env, key, "a.vcf", vcard(["FN:One"]))).headers.get("ETag");
	stats.beforeBatch = () => sql.prepare("UPDATE dav_cards SET fn = 'Edited', updated_at = updated_at + 1 WHERE name = 'a.vcf'").run();
	assert.equal((await putCard(env, key, "a.vcf", vcard(["FN:Phone"]), { "If-Match": etag })).status, 412);
	assert.equal(card(sql, "a.vcf").fn, "Edited");
	assert.equal(guardRows(sql), 0);
	stats.beforeBatch = () => sql.prepare("DELETE FROM dav_cards WHERE name = 'a.vcf'").run();
	assert.equal((await putCard(env, key, "a.vcf", vcard(["FN:Phone"]))).status, 412);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 0, "a vanished card is not resurrected by an update");
	const next = (await putCard(env, key, "b.vcf", vcard(["FN:B"], { uid: "b" }))).headers.get("ETag");
	stats.beforeBatch = () => sql.prepare("UPDATE dav_cards SET fn = 'Edited', updated_at = updated_at + 1 WHERE name = 'b.vcf'").run();
	assert.equal((await del(env, key, "b.vcf", { "If-Match": next }, BOOK)).status, 412);
	assert.equal(card(sql, "b.vcf").fn, "Edited");
});

test("cards are capped at 20 MB in total per user: over it is 507; replacing a card with a smaller one still works", async (t) => {
	const { env, key, sql } = await fixture(t);
	const body = vcard(["FN:Fresh"], { uid: "fresh" });
	sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('big', 'u1', 'card:u1', 'big.vcf', 'big', 'b', '3.0', ?, 1, 1)").run(20 * MiB - body.length + 1);
	assert.equal((await putCard(env, key, "fresh.vcf", body)).status, 507);
	sql.prepare("UPDATE dav_cards SET size = ? WHERE id = 'big'").run(20 * MiB - body.length);
	sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES ('o', 'u2', 'card:u2', 'o.vcf', 'o', 'b', '3.0', ?, 1, 1)").run(20 * MiB);
	assert.equal((await putCard(env, key, "fresh.vcf", body)).status, 201, "exactly at the cap");
	assert.equal((await putCard(env, key, "fresh.vcf", vcard(["FN:Fresh and longer"], { uid: "fresh" }))).status, 507);
	assert.equal((await putCard(env, key, "big.vcf", vcard(["FN:Small now"], { uid: "big" }))).status, 204);
	assert.equal((await putCard(env, key, "fresh.vcf", vcard(["FN:Fresh and longer"], { uid: "fresh" }))).status, 204);
});

test("a PUT onto an existing card cannot change its UID", async (t) => {
	const { env, key, sql } = await fixture(t);
	await putCard(env, key, "a.vcf", vcard(["FN:One"], { uid: "card-a" }));
	const cardRefused = await putCard(env, key, "a.vcf", vcard(["FN:Two"], { uid: "card-other" }));
	assert.equal(cardRefused.status, 403);
	assert.match(await cardRefused.text(), /<CR:no-uid-conflict><D:href>\/dav\/addressbooks\/u1\/default\/a\.vcf<\/D:href>/);
	assert.equal(card(sql, "a.vcf").fn, "One");
});

test("what is refused for a card: version, shape, UID, size, type", async (t) => {
	const { env, key, sql } = await fixture(t);
	const refused = async (promise, status, pattern) => {
		const response = await promise;
		assert.equal(response.status, status);
		if (pattern) assert.match(await response.text(), pattern);
	};
	await refused(putCard(env, key, "v.vcf", vcard(["FN:X"], { version: "2.1" })), 403, /<CR:supported-address-data\/>/);
	await refused(putCard(env, key, "nv.vcf", "BEGIN:VCARD\r\nUID:x\r\nFN:X\r\nEND:VCARD\r\n"), 403, /<CR:supported-address-data\/>/);
	await refused(putCard(env, key, "two.vcf", vcard(["FN:X"]) + vcard(["FN:Y"], { uid: "y" })), 403, /<CR:valid-address-data\/>/);
	await refused(putCard(env, key, "nouid.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nEND:VCARD\r\n"), 403, /<CR:valid-address-data\/>/);
	await refused(putCard(env, key, "long.vcf", vcard(["FN:X"], { uid: "x".repeat(192) })), 403, /<CR:valid-address-data\/>/);
	await refused(putCard(env, key, "junk.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\n"), 403, /<CR:valid-address-data\/>/);
	await refused(putCard(env, key, "big.vcf", "x".repeat(1_048_577)), 413);
	await refused(putCard(env, key, "ty.vcf", vcard(["FN:X"]), { "Content-Type": "text/calendar" }), 415);
	await refused(put(env, key, "ty.vcf", vcard(["FN:X"]), {}, BOOK), 415, undefined);
	await refused(putCard(env, key, "bad name.vcf", vcard(["FN:X"])), 400);
	await refused(putCard(env, key, "a.ics", vcard(["FN:X"])), 400);
	await refused(call(env, "PUT", "/dav/addressbooks/u2/default/x.vcf", { key, body: vcard(["FN:X"]), headers: { "Content-Type": "text/vcard" } }), 404);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 0);
});

test("the 5001st card is 507; replacing an existing one still works at the limit", async (t) => {
	const { env, key, sql } = await fixture(t);
	sql.exec("BEGIN");
	const insert = sql.prepare("INSERT INTO dav_cards (id, user_id, collection_id, name, uid, body, version, size, created_at, updated_at) VALUES (?, 'u1', 'card:u1', ?, ?, 'b', '3.0', 1, 1, 1)");
	for (let i = 0; i < 5000; i++) insert.run(`c${i}`, `c${String(i).padStart(4, "0")}.vcf`, `uid-${i}`);
	sql.exec("COMMIT");
	assert.equal((await putCard(env, key, "extra.vcf", vcard(["FN:Extra"], { uid: "extra" }))).status, 507);
	assert.equal((await putCard(env, key, "c0001.vcf", vcard(["FN:Same slot"], { uid: "uid-1" }))).status, 204);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 5000);
});

test("DELETE of a card honours If-Match, and sync reports it gone under its real name", async (t) => {
	const { env, key, sql } = await fixture(t);
	const etag = (await putCard(env, key, "ann.vcf", vcard(["FN:Ann"]))).headers.get("ETag");
	const token = tokenOf(await (await syncSince(env, key, "", BOOK)).text());
	assert.equal((await del(env, key, "ann.vcf", { "If-Match": '"0"' }, BOOK)).status, 412);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 1);
	assert.equal((await del(env, key, "ann.vcf", { "If-Match": etag }, BOOK)).status, 204);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 0);
	assert.equal((await del(env, key, "ann.vcf", {}, BOOK)).status, 404);
	assert.equal((await get(env, key, "ann.vcf", BOOK)).status, 404);
	const gone = await (await syncSince(env, key, token, BOOK)).text();
	assert.match(gone, new RegExp(`<D:href>${BOOK}ann\\.vcf</D:href><D:status>HTTP/1.1 404 Not Found</D:status>`));
	assert.doesNotMatch(gone, /card_/);
});

test("card writes need the dav scope and work with the calendar turned off; the write budget and the switch apply", async (t) => {
	const noCalendar = await fixture(t, { calendarEnabled: false });
	assert.equal((await putCard(noCalendar.env, noCalendar.key, "a.vcf", vcard(["FN:A"]))).status, 201);
	const scoped = await fixture(t, { scopes: '["jmap"]' });
	assert.equal((await putCard(scoped.env, scoped.key, "a.vcf", vcard(["FN:A"]))).status, 401);
	const limited = await fixture(t, { writeLimiter: { limit: async () => ({ success: false }) } });
	assert.equal((await putCard(limited.env, limited.key, "a.vcf", vcard(["FN:A"]))).status, 503);
	assert.equal(limited.sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 0);
	const off = await fixture(t, { enabled: false });
	assert.equal((await putCard(off.env, off.key, "a.vcf", vcard(["FN:A"]))).status, 404);
	assert.equal(off.sql.prepare("SELECT count(*) AS n FROM dav_cards").get().n, 0);
});

test("a card PUT is a handful of statements and never fetches", async (t) => {
	const { env, key, stats } = await fixture(t);
	const real = globalThis.fetch;
	globalThis.fetch = () => {
		throw new Error("DAV must not fetch");
	};
	try {
		reset(stats);
		assert.equal((await putCard(env, key, "p.vcf", vcard(["FN:P", "PHOTO;VALUE=uri:http://photo.invalid/p.jpg", "URL:http://url.invalid/"]))).status, 201);
		assert.ok(stats.queries <= 15, `statements: ${stats.queries}`);
		assert.ok(stats.maxParams < 100);
	} finally {
		globalThis.fetch = real;
	}
});

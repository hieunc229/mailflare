import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// CS-4: calendars shared with a user are collections in their CalDAV home (spec F9 D-12, 8.8).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-cal-dav-shared-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest } from "./src/lib/dav/handler.ts";
			export { clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { changeShare } from "./src/lib/calendar/shares.ts";
			export { getDb } from "./src/db/index.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "cal-dav-shared-entry.ts",
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
const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, changeShare, getDb, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";
const XML = { "Content-Type": "application/xml" };
const ICS = { "Content-Type": "text/calendar; charset=utf-8" };
const GRANT = "csh_read";
const SHARED = (id = GRANT, user = "u2") => `/dav/calendars/${user}/shared-${id}/`;

/** u1 owns the calendar "Work"; u2 reads it, u3 edits it, u4 manages it, u5 has free/busy only; u6 has no grant. */
async function fixture(t) {
	clearApiKeyVerificationCache();
	clearDavEnabledCache();
	const database = new SqliteDatabase(":memory:");
	t.after(() => { database.db.close(); clearApiKeyVerificationCache(); clearDavEnabledCache(); });
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const user = sql.prepare("INSERT INTO users (id, email, name, password_hash, role, calendar_enabled, time_zone, created_at) VALUES (?, ?, ?, 'x', 'user', 1, 'Europe/Berlin', 1)");
	for (const id of ["u1", "u2", "u3", "u4", "u5", "u6"]) user.run(id, `${id}@one.test`, `User ${id}`);
	sql.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	const keys = {};
	for (const id of ["u1", "u2", "u3", "u4", "u5", "u6"]) {
		keys[id] = await generateAppPassword();
		sql.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES (?, ?, 'phone', ?, ?, ?, 'app', '[\"dav\"]', 1)").run(`k-${id}`, id, keys[id].prefix, keys[id].hash, keys[id].sha256);
	}
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1)").run();
	const grant = sql.prepare("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES (?, 'cal:work', ?, ?, 1)");
	grant.run(GRANT, "u2", "read");
	grant.run("csh_edit", "u3", "edit");
	grant.run("csh_manage", "u4", "manage");
	grant.run("csh_fb", "u5", "freebusy");
	return { sql, keys, env: { DB: database }, database };
}

const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const call = (env, method, path, { key, body, headers = {} } = {}) => handleDavRequest(new Request(`${ORIGIN}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const propfind = (env, path, key, props, depth = "0") => call(env, "PROPFIND", path, { key, headers: { Depth: depth, ...XML }, body: `<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/"><A:prop>${props}</A:prop></A:propfind>` });
const report = (env, path, key, body) => call(env, "REPORT", path, { key, body: `<?xml version="1.0"?>${body}`, headers: { Depth: "0", ...XML } });
const NS = `xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;
const syncSince = (env, path, key, token) => report(env, path, key, `<A:sync-collection ${NS}><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`);
const tokenOf = (text) => text.match(/<D:sync-token>([^<]*)<\/D:sync-token>/)[1];
const hrefs = (text) => [...text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const put = (env, path, key, body, headers = {}) => call(env, "PUT", path, { key, body, headers: { ...ICS, ...headers } });
const get = async (env, path, key) => { const response = await call(env, "GET", path, { key }); return { status: response.status, text: await response.text(), etag: response.headers.get("ETag") }; };
const vevent = (uid, title, extra = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 26//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
const addEvent = (sql, id, { calendar = "cal:work", owner = "u1", title = `Title ${id}`, description = "", location = "", attendees = "[]", isPrivate = 0, reminder = null } = {}) =>
	sql.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, description, location, attendees, is_private, reminder_minutes, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1793000000, 1793003600, 1, 1)").run(id, owner, calendar, title, description, location, attendees, isPrivate, reminder);
const audit = (sql) => sql.prepare("SELECT actor_user_id, target_user_id, action, metadata FROM audit_logs ORDER BY rowid").all();

test("the home lists a shared calendar as shared-<grantId>/ for read and above, never free/busy or an unshared one", async (t) => {
	const { env, keys } = await fixture(t);
	const home = async (user) => hrefs(await (await propfind(env, `/dav/calendars/${user}/`, keys[user], "<A:displayname/>", "1")).text()).filter((href) => href.includes("shared-") || href.includes("c-"));
	assert.deepEqual(await home("u2"), [SHARED()]);
	assert.deepEqual(await home("u3"), [SHARED("csh_edit", "u3")]);
	assert.deepEqual(await home("u4"), [SHARED("csh_manage", "u4")]);
	assert.deepEqual(await home("u5"), [], "a free/busy grant is not a calendar");
	assert.deepEqual(await home("u6"), []);
	assert.match(await (await propfind(env, "/dav/calendars/u2/", keys.u2, "<A:displayname/>", "1")).text(), /<D:displayname>Work \(User u1\)<\/D:displayname>/);
});

test("current-user-privilege-set is read-only for read and the F6 set for edit, manage and the owner", async (t) => {
	const { env, keys } = await fixture(t);
	const privileges = async (path, user) => [...(await (await propfind(env, path, keys[user], "<A:current-user-privilege-set/>")).text()).matchAll(/<D:privilege><D:([a-z-]+)\/><\/D:privilege>/g)].map((m) => m[1]);
	assert.deepEqual(await privileges(SHARED(), "u2"), ["read", "read-current-user-privilege-set"]);
	const full = ["read", "write", "write-content", "bind", "unbind", "read-current-user-privilege-set"];
	assert.deepEqual(await privileges(SHARED("csh_edit", "u3"), "u3"), full);
	assert.deepEqual(await privileges(SHARED("csh_manage", "u4"), "u4"), full);
	assert.deepEqual(await privileges("/dav/calendars/u1/c-work/", "u1"), full);
});

test("a read grantee gets private events redacted per request, never the stored body, and nothing is written", async (t) => {
	const { env, keys, sql } = await fixture(t);
	// The owner's phone PUT this body: it holds text and an alarm no one else may see.
	const secret = vevent("uid-private", "Therapy", "CLASS:PRIVATE\r\nDESCRIPTION:Secret notes\r\nLOCATION:Secret room\r\nX-SECRET:hidden\r\nATTENDEE:mailto:guest@x.test\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Therapy\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n");
	assert.equal((await put(env, "/dav/calendars/u1/c-work/p.ics", keys.u1, secret)).status, 201);
	assert.equal((await put(env, "/dav/calendars/u1/c-work/q.ics", keys.u1, vevent("uid-public", "Standup", "DESCRIPTION:Agenda\r\nLOCATION:Room 1\r\n"))).status, 201);
	const stored = sql.prepare("SELECT name, body FROM dav_calendar_objects ORDER BY name").all();
	const reader = await get(env, `${SHARED()}p.ics`, keys.u2);
	assert.equal(reader.status, 200);
	assert.match(reader.text, /SUMMARY:Busy/);
	assert.match(reader.text, /CLASS:PRIVATE/);
	assert.doesNotMatch(reader.text, /Therapy|Secret|hidden|guest@x\.test|VALARM|DESCRIPTION|LOCATION/);
	assert.match(reader.text, /DTSTART:20261102T090000Z/, "start and end stay");
	const open = await get(env, `${SHARED()}q.ics`, keys.u2);
	assert.match(open.text, /SUMMARY:Standup/);
	assert.match(open.text, /DESCRIPTION:Agenda/);
	assert.deepEqual(sql.prepare("SELECT name, body FROM dav_calendar_objects ORDER BY name").all(), stored, "a redacted body is never written to dav_calendar_objects");
	// The same through a multiget and a calendar-query.
	const multiget = await (await report(env, SHARED(), keys.u2, `<C:calendar-multiget ${NS}><A:prop><C:calendar-data/></A:prop><A:href>${SHARED()}p.ics</A:href></C:calendar-multiget>`)).text();
	assert.doesNotMatch(multiget, /Therapy|Secret|hidden|VALARM/);
	const query = await (await report(env, SHARED(), keys.u2, `<C:calendar-query ${NS}><A:prop><C:calendar-data/></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`)).text();
	assert.doesNotMatch(query, /Therapy|Secret|hidden|VALARM/);
	assert.match(query, /Standup/);
	// The owner still gets what the phone wrote.
	assert.match((await get(env, "/dav/calendars/u1/c-work/p.ics", keys.u1)).text, /Secret notes/);
});

test("an edit grantee sees private events in full, without the owner's alarm", async (t) => {
	const { env, keys } = await fixture(t);
	const body = vevent("uid-private", "Therapy", "CLASS:PRIVATE\r\nDESCRIPTION:Secret notes\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Therapy\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n");
	await put(env, "/dav/calendars/u1/c-work/p.ics", keys.u1, body);
	const editor = await get(env, `${SHARED("csh_edit", "u3")}p.ics`, keys.u3);
	assert.match(editor.text, /SUMMARY:Therapy/);
	assert.match(editor.text, /DESCRIPTION:Secret notes/);
	assert.match(editor.text, /CLASS:PRIVATE/);
	assert.doesNotMatch(editor.text, /VALARM/);
});

test("moved occurrences of a private series are redacted too", async (t) => {
	const { env, keys } = await fixture(t);
	const series = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 26//EN\r\nBEGIN:VEVENT\r\nUID:uid-s\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nRRULE:FREQ=WEEKLY\r\nCLASS:PRIVATE\r\nSUMMARY:Therapy\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:uid-s\r\nDTSTAMP:20261101T000000Z\r\nRECURRENCE-ID:20261109T090000Z\r\nDTSTART:20261109T100000Z\r\nDTEND:20261109T110000Z\r\nSUMMARY:Therapy moved\r\nDESCRIPTION:Secret move\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
	assert.equal((await put(env, "/dav/calendars/u1/c-work/s.ics", keys.u1, series)).status, 201);
	const reader = await get(env, `${SHARED()}s.ics`, keys.u2);
	assert.equal((reader.text.match(/BEGIN:VEVENT/g) ?? []).length, 2);
	assert.doesNotMatch(reader.text, /Therapy|Secret/);
	assert.equal((reader.text.match(/CLASS:PRIVATE/g) ?? []).length, 2);
	assert.match(reader.text, /DTSTART:20261109T100000Z/, "the moved time stays");
});

test("a PUT or DELETE into a read collection is 403 need-privileges and changes nothing", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_a");
	const refused = await put(env, `${SHARED()}new.ics`, keys.u2, vevent("uid-new", "Sneaky"));
	assert.equal(refused.status, 403);
	assert.match(await refused.text(), /need-privileges/);
	assert.equal((await call(env, "DELETE", `${SHARED()}evt_a.ics`, { key: keys.u2 })).status, 403);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM audit_logs").get().n, 0);
});

test("PROPPATCH of a shared collection is refused 403 below manage, and MKCALENDAR stays 403", async (t) => {
	const { env, keys } = await fixture(t);
	const body = '<?xml version="1.0"?><A:propertyupdate xmlns:A="DAV:" xmlns:I="http://apple.com/ns/ical/"><A:set><A:prop><A:displayname>Mine</A:displayname><I:calendar-color>#FF0000FF</I:calendar-color></A:prop></A:set></A:propertyupdate>';
	for (const [user, grant] of [["u2", GRANT], ["u3", "csh_edit"]]) {
		const response = await call(env, "PROPPATCH", SHARED(grant, user), { key: keys[user], body, headers: XML });
		assert.equal(response.status, 403, user);
		assert.match(await response.text(), /need-privileges/);
	}
	assert.equal((await call(env, "MKCALENDAR", `/dav/calendars/u1/c-new/`, { key: keys.u1 })).status, 403);
});

test("a revoked grant, an owner with Calendar off and a re-keyed grant close the old collection on the next request", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_a");
	assert.equal((await get(env, `${SHARED()}evt_a.ics`, keys.u2)).status, 200);
	const token = tokenOf(await (await syncSince(env, SHARED(), keys.u2, "")).text());
	// A role change re-creates the grant under a new id (D-5): the phone sees the old collection vanish and a new one.
	const changed = await changeShare(getDb(env), { id: "u1" }, "cal:work", { id: GRANT, role: "edit" });
	assert.equal(changed.ok, true);
	assert.equal((await propfind(env, SHARED(), keys.u2, "<A:displayname/>")).status, 404);
	assert.equal((await syncSince(env, SHARED(), keys.u2, token)).status, 404);
	const fresh = `/dav/calendars/u2/shared-${changed.share.id}/`;
	assert.equal((await get(env, `${fresh}evt_a.ics`, keys.u2)).status, 200);
	assert.deepEqual(hrefs(await (await propfind(env, "/dav/calendars/u2/", keys.u2, "<A:displayname/>", "1")).text()).filter((href) => href.includes("shared-")), [fresh]);
	// Calendar turned off for the owner.
	sql.prepare("UPDATE users SET calendar_enabled = 0 WHERE id = 'u1'").run();
	assert.equal((await get(env, `${fresh}evt_a.ics`, keys.u2)).status, 404);
	assert.deepEqual(hrefs(await (await propfind(env, "/dav/calendars/u2/", keys.u2, "<A:displayname/>", "1")).text()).filter((href) => href.includes("shared-")), []);
	sql.prepare("UPDATE users SET calendar_enabled = 1 WHERE id = 'u1'").run();
	// Revoked.
	sql.prepare("DELETE FROM calendar_shares WHERE id = ?").run(changed.share.id);
	assert.equal((await get(env, `${fresh}evt_a.ics`, keys.u2)).status, 404);
	assert.equal((await put(env, `${fresh}x.ics`, keys.u2, vevent("u", "t"))).status, 404);
});

test("nobody else can use a grant's collection name, and a free/busy grant has none", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_a");
	for (const user of ["u1", "u3", "u6"]) assert.equal((await get(env, `/dav/calendars/${user}/shared-${GRANT}/evt_a.ics`, keys[user])).status, 404, user);
	assert.equal((await propfind(env, SHARED("csh_fb", "u5"), keys.u5, "<A:displayname/>")).status, 404);
	assert.equal((await get(env, "/dav/calendars/u2/c-work/evt_a.ics", keys.u2)).status, 404, "a granted calendar is not served under an own name");
});

test("the default calendar can be shared: its events (no calendar id) are served", async (t) => {
	const { env, keys, sql } = await fixture(t);
	sql.prepare("INSERT INTO dav_collections (id, user_id, kind, created_at, updated_at) VALUES ('cal:u1', 'u1', 'calendar', 1, 1)").run();
	sql.prepare("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('csh_def', 'cal:u1', 'u2', 'read', 1)").run();
	addEvent(sql, "evt_default", { calendar: null });
	addEvent(sql, "evt_work");
	assert.deepEqual(hrefs(await (await propfind(env, SHARED("csh_def"), keys.u2, "<A:getetag/>", "1")).text()).filter((href) => href.endsWith(".ics")), [`${SHARED("csh_def")}evt_default.ics`]);
});

test("sync works per shared collection and reports the owner's changes", async (t) => {
	const { env, keys, sql } = await fixture(t);
	const token = tokenOf(await (await syncSince(env, SHARED(), keys.u2, "")).text());
	addEvent(sql, "evt_new");
	assert.deepEqual(hrefs(await (await syncSince(env, SHARED(), keys.u2, token)).text()).filter((href) => href.endsWith(".ics")), [`${SHARED()}evt_new.ics`]);
	assert.equal((await syncSince(env, SHARED(), keys.u3, token)).status, 404, "another user's request for this collection");
});

test("an edit delegate's PUT writes the owner's row, audits it and sends no mail", async (t) => {
	const { env, keys, sql } = await fixture(t);
	const path = `${SHARED("csh_edit", "u3")}new.ics`;
	assert.equal((await put(env, path, keys.u3, vevent("uid-new", "Planning"))).status, 201);
	const row = sql.prepare("SELECT e.id, e.user_id, e.calendar_id, o.collection_id FROM calendar_events e JOIN dav_calendar_objects o ON o.id = e.id WHERE o.name = 'new.ics'").get();
	assert.deepEqual({ user: row.user_id, calendar: row.calendar_id, collection: row.collection_id }, { user: "u1", calendar: "cal:work", collection: "cal:work" });
	assert.deepEqual(audit(sql).map((entry) => [entry.actor_user_id, entry.target_user_id, entry.action, JSON.parse(entry.metadata)]), [["u3", "u1", "calendar.event_created_by_delegate", { calendarId: "cal:work", eventId: row.id }]]);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM outbound_jobs").get().n, 0);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
	// The owner sees it in their own collection; an update by the delegate is audited as an update, a delete as a delete.
	assert.equal((await get(env, "/dav/calendars/u1/c-work/new.ics", keys.u1)).status, 200);
	const etag = (await get(env, path, keys.u3)).etag;
	assert.equal((await put(env, path, keys.u3, vevent("uid-new", "Planning v2"), { "If-Match": etag })).status, 204);
	const etag2 = (await get(env, path, keys.u3)).etag;
	assert.equal((await call(env, "DELETE", path, { key: keys.u3, headers: { "If-Match": etag2 } })).status, 204);
	assert.deepEqual(audit(sql).map((entry) => entry.action), ["calendar.event_created_by_delegate", "calendar.event_updated_by_delegate", "calendar.event_deleted_by_delegate"]);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
});

test("a manage delegate writes too; the owner's own writes are not audited", async (t) => {
	const { env, keys, sql } = await fixture(t);
	assert.equal((await put(env, `${SHARED("csh_manage", "u4")}m.ics`, keys.u4, vevent("uid-m", "Managed"))).status, 201);
	assert.equal((await put(env, "/dav/calendars/u1/c-work/o.ics", keys.u1, vevent("uid-o", "Own"))).status, 201);
	assert.deepEqual(audit(sql).map((entry) => [entry.actor_user_id, entry.action]), [["u4", "calendar.event_created_by_delegate"]]);
});

test("a delegate cannot add guests: 403 and nothing is written", async (t) => {
	const { env, keys, sql } = await fixture(t);
	const refused = await put(env, `${SHARED("csh_edit", "u3")}g.ics`, keys.u3, vevent("uid-g", "With guests", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@x.test\r\n"));
	assert.equal(refused.status, 403);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM audit_logs").get().n, 0);
});

test("a delegate saving an event with its guests as they are keeps the stored guest list byte for byte; changing it is 403", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_g", { attendees: '["guest@x.test"]' });
	sql.prepare("UPDATE calendar_events SET attendee_responses = '{\"guest@x.test\":\"accepted\"}' WHERE id = 'evt_g'").run();
	const path = `${SHARED("csh_edit", "u3")}evt_g.ics`;
	const before = sql.prepare("SELECT attendees, attendee_responses FROM calendar_events WHERE id = 'evt_g'").get();
	// The phone echoes the guest but, as phones do, without the PARTSTAT it was given.
	assert.equal((await put(env, path, keys.u3, vevent("evt_g@mailflare", "Retitled", "ATTENDEE:mailto:guest@x.test\r\n"))).status, 204);
	const after = sql.prepare("SELECT title, user_id, attendees, attendee_responses FROM calendar_events WHERE id = 'evt_g'").get();
	assert.equal(after.title, "Retitled");
	assert.equal(after.user_id, "u1");
	assert.deepEqual({ attendees: after.attendees, attendee_responses: after.attendee_responses }, before);
	for (const extra of ["ATTENDEE:mailto:guest@x.test\r\nATTENDEE:mailto:other@x.test\r\n", "ATTENDEE:mailto:other@x.test\r\n"]) {
		const refused = await put(env, path, keys.u3, vevent("evt_g@mailflare", "Changed guests", extra));
		assert.equal(refused.status, 403, extra);
	}
	assert.equal(sql.prepare("SELECT title FROM calendar_events WHERE id = 'evt_g'").get().title, "Retitled");
});

test("a delegate's PUT keeps what belongs to the owner: response status, invitation sender, reminder", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_i", { reminder: 30 });
	sql.prepare("UPDATE calendar_events SET response_status = 'accepted', invite_sender = 'boss@x.test' WHERE id = 'evt_i'").run();
	assert.equal((await put(env, `${SHARED("csh_edit", "u3")}evt_i.ics`, keys.u3, vevent("evt_i@mailflare", "Edited", "STATUS:CANCELLED\r\n"))).status, 204);
	const row = sql.prepare("SELECT title, response_status, invite_sender, reminder_minutes FROM calendar_events WHERE id = 'evt_i'").get();
	assert.deepEqual({ ...row }, { title: "Edited", response_status: "accepted", invite_sender: "boss@x.test", reminder_minutes: 30 });
});

test("a revoke between the check and the write refuses the write (the batch carries a grant guard)", async (t) => {
	const { env, keys, sql } = await fixture(t);
	const body = vevent("uid-race", "Race");
	const original = env.DB.batch.bind(env.DB);
	env.DB.batch = async (statements) => { sql.prepare("DELETE FROM calendar_shares WHERE id = 'csh_edit'").run(); return original(statements); };
	const response = await put(env, `${SHARED("csh_edit", "u3")}r.ics`, keys.u3, body);
	assert.ok([403, 404, 412].includes(response.status), String(response.status));
	assert.equal(sql.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
});

test("same UID in a shared collection and in the delegate's own calendar are separate events", async (t) => {
	const { env, keys } = await fixture(t);
	assert.equal((await put(env, "/dav/calendars/u3/default/a.ics", keys.u3, vevent("same", "Mine"))).status, 201);
	assert.equal((await put(env, `${SHARED("csh_edit", "u3")}a.ics`, keys.u3, vevent("same", "Theirs"))).status, 201);
});

test("documented limit: a read grantee's ETag and sync report move when the owner edits a private event, which tells them that it changed and when, never what", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_p", { isPrivate: 1, description: "Secret notes" });
	const path = `${SHARED()}evt_p.ics`;
	const before = await get(env, path, keys.u2);
	assert.match(before.etag, /^"\d+"$/, "an ETag is a change number: no hash or text of the event is in it");
	sql.prepare("UPDATE calendar_events SET description = 'Other secret', updated_at = updated_at + 1 WHERE id = 'evt_p'").run();
	const after = await get(env, path, keys.u2);
	assert.notEqual(after.etag, before.etag);
	const stamps = (text) => text.replace(/(DTSTAMP|LAST-MODIFIED):\d+T\d+Z/g, "");
	assert.equal(stamps(after.text), stamps(before.text), "the redacted body shows no change but its time stamps");
	assert.doesNotMatch(after.text, /secret/i);
});

test("a phone that was never sent the guests (a redacted-render body has no ATTENDEE lines) can still move the event; the guests stay", async (t) => {
	const { env, keys, sql } = await fixture(t);
	addEvent(sql, "evt_g", { attendees: '["guest@x.test"]' });
	const path = `${SHARED("csh_edit", "u3")}evt_g.ics`;
	assert.doesNotMatch((await get(env, path, keys.u3)).text, /ATTENDEE/);
	assert.equal((await put(env, path, keys.u3, vevent("evt_g@mailflare", "Moved by phone"))).status, 204);
	const row = sql.prepare("SELECT title, attendees FROM calendar_events WHERE id = 'evt_g'").get();
	assert.deepEqual({ ...row }, { title: "Moved by phone", attendees: '["guest@x.test"]' });
});

test("a delegate's text is never stored as the owner's body: the owner's phone keeps its own alarm and gets no PARTSTAT, ORGANIZER or alarm of the delegate", async (t) => {
	const { env, keys } = await fixture(t);
	const own = vevent("uid-o", "Mine", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Mine\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\n");
	assert.equal((await put(env, "/dav/calendars/u1/c-work/o.ics", keys.u1, own)).status, 201);
	const etag = (await get(env, `${SHARED("csh_edit", "u3")}o.ics`, keys.u3)).etag;
	const delegate = vevent("uid-o", "Mine, moved", "ORGANIZER:mailto:u3@one.test\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER:-PT1H\r\nEND:VALARM\r\nX-DELEGATE:yes\r\n");
	assert.equal((await put(env, `${SHARED("csh_edit", "u3")}o.ics`, keys.u3, delegate, { "If-Match": etag })).status, 204);
	const seen = (await get(env, "/dav/calendars/u1/c-work/o.ics", keys.u1)).text;
	assert.match(seen, /SUMMARY:Mine\\, moved/);
	assert.match(seen, /TRIGGER:-PT10M/, "the owner's alarm");
	assert.doesNotMatch(seen, /PT1H|ORGANIZER|X-DELEGATE/);
});

test("an override row that is not in its master's calendar is not served with it (defence in depth for a stray row)", async (t) => {
	const { env, keys, sql } = await fixture(t);
	sql.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, repeat, dav_object_id, created_at, updated_at) VALUES ('m1', 'u1', 'cal:work', 'Series', 1793000000, 1793003600, 'weekly', 'm1', 1, 1)").run();
	sql.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, dav_object_id, recurrence_id, created_at, updated_at) VALUES ('o1', 'u1', NULL, 'Stray occurrence', 1793090000, 1793093600, 'm1', 1793086400, 1, 1)").run();
	const text = (await get(env, `${SHARED()}m1.ics`, keys.u2)).text;
	assert.match(text, /SUMMARY:Series/);
	assert.doesNotMatch(text, /Stray occurrence/);
});

test("a delegate's PUT cannot inflate the owner's stored bytes: an update keeps the owner's size, a new event counts nothing", async (t) => {
	const { env, keys, sql } = await fixture(t);
	const total = () => Number(sql.prepare("SELECT coalesce(sum(size), 0) AS n FROM dav_calendar_objects WHERE user_id = 'u1'").get().n);
	assert.equal((await put(env, "/dav/calendars/u1/c-work/o.ics", keys.u1, vevent("uid-o", "Mine"))).status, 201);
	const owned = total();
	assert.ok(owned > 0);
	const path = `${SHARED("csh_edit", "u3")}o.ics`;
	const etag = (await get(env, path, keys.u3)).etag;
	assert.equal((await put(env, path, keys.u3, vevent("uid-o", "Mine", `X-PAD:${"x".repeat(400_000)}\r\n`), { "If-Match": etag })).status, 204);
	assert.equal(total(), owned);
	assert.equal((await put(env, `${SHARED("csh_edit", "u3")}n.ics`, keys.u3, vevent("uid-n", "New", `X-PAD:${"x".repeat(400_000)}\r\n`))).status, 201);
	assert.equal(total(), owned);
});

test("a delegate's PUT answers without an ETag, since the stored text is not what it sent (RFC 4791 5.3.4); the owner's PUT still has one", async (t) => {
	const { env, keys } = await fixture(t);
	const created = await put(env, `${SHARED("csh_edit", "u3")}n.ics`, keys.u3, vevent("uid-n", "New"));
	assert.equal(created.status, 201);
	assert.equal(created.headers.get("ETag"), null);
	const replaced = await put(env, `${SHARED("csh_edit", "u3")}n.ics`, keys.u3, vevent("uid-n", "New 2"), { "If-Match": (await get(env, `${SHARED("csh_edit", "u3")}n.ics`, keys.u3)).etag });
	assert.equal(replaced.status, 204);
	assert.equal(replaced.headers.get("ETag"), null);
	assert.match((await put(env, "/dav/calendars/u1/c-work/o.ics", keys.u1, vevent("uid-o", "Mine"))).headers.get("ETag"), /^"\d+"$/);
});

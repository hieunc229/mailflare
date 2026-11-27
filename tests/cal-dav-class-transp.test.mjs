import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// CS-4 (spec F9 8.8): CLASS and TRANSP are mapped to is_private / transparent, so a phone's edit round-trips.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-cal-dav-class-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest } from "./src/lib/dav/handler.ts";
			export { clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { parseCalendarObject } from "./src/lib/dav/calendar-parse.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "cal-dav-class-entry.ts",
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
const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, parseCalendarObject, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";
const CAL = "/dav/calendars/u1/default/";
const ICS = { "Content-Type": "text/calendar; charset=utf-8" };

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
	return { sql, key, env: { DB: database } };
}
const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const call = (env, method, path, { key, body, headers = {} } = {}) => handleDavRequest(new Request(`${ORIGIN}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const vevent = (extra = "", uid = "uid-1") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 26//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nSUMMARY:T\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
const flags = (sql) => sql.prepare("SELECT is_private AS p, transparent AS t FROM calendar_events ORDER BY created_at, id").all().map((row) => [row.p, row.t]);

test("parse: CLASS PRIVATE or CONFIDENTIAL is private, anything else public; TRANSP TRANSPARENT is free; overrides carry their own", () => {
	const flagsOf = (extra) => { const parsed = parseCalendarObject(vevent(extra), "UTC", []); return [parsed.master.isPrivate, parsed.master.transparent]; };
	assert.deepEqual(flagsOf(""), [false, false]);
	assert.deepEqual(flagsOf("CLASS:PRIVATE\r\n"), [true, false]);
	assert.deepEqual(flagsOf("CLASS:confidential\r\n"), [true, false]);
	assert.deepEqual(flagsOf("CLASS:PUBLIC\r\n"), [false, false]);
	assert.deepEqual(flagsOf("TRANSP:TRANSPARENT\r\n"), [false, true]);
	assert.deepEqual(flagsOf("TRANSP:OPAQUE\r\nCLASS:PRIVATE\r\n"), [true, false]);
	const series = vevent("RRULE:FREQ=DAILY\r\n").replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:uid-1\r\nDTSTAMP:20261101T000000Z\r\nRECURRENCE-ID:20261103T090000Z\r\nDTSTART:20261103T100000Z\r\nDTEND:20261103T110000Z\r\nSUMMARY:T\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR");
	const parsed = parseCalendarObject(series, "UTC", []);
	assert.deepEqual([parsed.master.transparent, parsed.overrides[0].transparent, parsed.overrides[0].isPrivate], [false, true, false]);
});

test("a PUT stores the flags and a later PUT replaces them", async (t) => {
	const { env, key, sql } = await fixture(t);
	assert.equal((await call(env, "PUT", `${CAL}a.ics`, { key, body: vevent("CLASS:PRIVATE\r\nTRANSP:TRANSPARENT\r\n"), headers: ICS })).status, 201);
	assert.deepEqual(flags(sql), [[1, 1]]);
	const etag = (await call(env, "GET", `${CAL}a.ics`, { key })).headers.get("ETag");
	assert.equal((await call(env, "PUT", `${CAL}a.ics`, { key, body: vevent(""), headers: { ...ICS, "If-Match": etag } })).status, 204);
	assert.deepEqual(flags(sql), [[0, 0]], "a phone that drops CLASS makes the event public again");
});

test("a web change of the flags is merged into the stored body, replacing the client's own CLASS and TRANSP", async (t) => {
	const { env, key, sql } = await fixture(t);
	await call(env, "PUT", `${CAL}a.ics`, { key, body: vevent("CLASS:PUBLIC\r\nTRANSP:OPAQUE\r\nX-KEEP:yes\r\n"), headers: ICS });
	const before = await (await call(env, "GET", `${CAL}a.ics`, { key })).text();
	assert.match(before, /CLASS:PUBLIC/);
	sql.prepare("UPDATE calendar_events SET is_private = 1, transparent = 1, updated_at = updated_at + 1").run();
	const after = await (await call(env, "GET", `${CAL}a.ics`, { key })).text();
	assert.equal((after.match(/CLASS:/g) ?? []).length, 1);
	assert.match(after, /CLASS:PRIVATE/);
	assert.equal((after.match(/TRANSP:/g) ?? []).length, 1);
	assert.match(after, /TRANSP:TRANSPARENT/);
	assert.match(after, /X-KEEP:yes/);
	sql.prepare("UPDATE calendar_events SET is_private = 0, transparent = 0, updated_at = updated_at + 1").run();
	const cleared = await (await call(env, "GET", `${CAL}a.ics`, { key })).text();
	assert.equal(cleared, before, "back to the rows the phone wrote: its own body again, byte for byte");
});

test("an unflagged event's stored body is still served byte for byte", async (t) => {
	const { env, key } = await fixture(t);
	const body = vevent("X-KEEP:yes\r\n");
	await call(env, "PUT", `${CAL}a.ics`, { key, body, headers: ICS });
	assert.equal(await (await call(env, "GET", `${CAL}a.ics`, { key })).text(), body);
});

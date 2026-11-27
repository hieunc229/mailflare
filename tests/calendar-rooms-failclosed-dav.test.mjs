import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// I-1: a CalDAV write that changes an event's time declines its room bookings in the same batch, so a stop before the room step leaves none accepted unchecked.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-room-dav-fc-"));
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
		sourcefile: "room-dav-fc-entry.ts",
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
	// The room step that follows a write never runs (the process died after the batch): rebookEvents does nothing.
	plugins: [{ name: "room-step-dies", setup(build) {
		build.onResolve({ filter: /room-save$/ }, () => ({ path: "room-save-stub", namespace: "stub" }));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export * from "./src/lib/calendar/room-save.ts"; export async function rebookEvents() {}', loader: "ts", resolveDir: root }));
	} }],
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

test("a phone's PUT that moves a booked event declines its bookings in the same batch (the room step never ran)", async (t) => {
	const { env, key, sql } = await fixture(t);
	assert.equal((await call(env, "PUT", `${CAL}a.ics`, { key, body: vevent(""), headers: ICS })).status, 201);
	const id = sql.prepare("SELECT id FROM calendar_events").get().id;
	sql.prepare("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)").run();
	sql.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', ?, 'accepted', 1)").run(id);
	const etag = (await call(env, "GET", `${CAL}a.ics`, { key })).headers.get("ETag");
	const moved = vevent("").replace("DTSTART:20261102T090000Z", "DTSTART:20261102T130000Z").replace("DTEND:20261102T100000Z", "DTEND:20261102T140000Z");
	assert.equal((await call(env, "PUT", `${CAL}a.ics`, { key, body: moved, headers: { ...ICS, "If-Match": etag } })).status, 204);
	assert.equal(sql.prepare("SELECT status FROM calendar_resource_bookings WHERE id = 'b1'").get().status, "declined");
});

test("a PUT of an event with no rooms is unaffected", async (t) => {
	const { env, key, sql } = await fixture(t);
	await call(env, "PUT", `${CAL}a.ics`, { key, body: vevent(""), headers: ICS });
	const etag = (await call(env, "GET", `${CAL}a.ics`, { key })).headers.get("ETag");
	assert.equal((await call(env, "PUT", `${CAL}a.ics`, { key, body: vevent("X-A:1\r\n"), headers: { ...ICS, "If-Match": etag } })).status, 204);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM calendar_resource_bookings").get().n, 0);
});

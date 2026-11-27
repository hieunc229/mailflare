import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// M-5 on the CalDAV path: with the Team licence lapsed a declined room stays declined when a phone moves the event; with a licence it is checked again.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-room-dav-lapse-"));
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
		sourcefile: "room-dav-lapse-entry.ts",
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
	// The licence is whatever the test says; everything else is the real code.
	plugins: [{ name: "licence", setup(build) {
		build.onResolve({ filter: /licenses\/service$/ }, () => ({ path: "licence-stub", namespace: "stub" }));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomTeam===true}}", loader: "js" }));
	} }],
});
const { handleDavRequest, clearDavEnabledCache, generateAppPassword, clearApiKeyVerificationCache, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

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

async function booked(t, team) {
	globalThis.roomTeam = team;
	const { env, key, sql } = await fixture(t);
	assert.equal((await call(env, "PUT", `${CAL}a.ics`, { key, body: vevent(""), headers: ICS })).status, 201);
	const id = sql.prepare("SELECT id FROM calendar_events").get().id;
	sql.prepare("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room one', 1, 1), ('r2', 'Room two', 1, 1)").run();
	// r1 was declined (it was taken when booked) and is free now; r2 is accepted.
	sql.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', ?, 'declined', 1), ('b2', 'r2', ?, 'accepted', 1)").run(id, id);
	const etag = (await call(env, "GET", `${CAL}a.ics`, { key })).headers.get("ETag");
	const moved = vevent("").replace("DTSTART:20261102T090000Z", "DTSTART:20261102T130000Z").replace("DTEND:20261102T100000Z", "DTEND:20261102T140000Z");
	assert.equal((await call(env, "PUT", `${CAL}a.ics`, { key, body: moved, headers: { ...ICS, "If-Match": etag } })).status, 204);
	return sql.prepare("SELECT resource_id, status FROM calendar_resource_bookings ORDER BY resource_id").all().map((row) => [row.resource_id, row.status]);
}

test("licence lapsed: a phone moving the event keeps the declined room declined and the accepted one accepted", async (t) => {
	assert.deepEqual(await booked(t, false), [["r1", "declined"], ["r2", "accepted"]]);
});

test("with a Team licence the same PUT checks both rooms again, so the free one is accepted", async (t) => {
	assert.deepEqual(await booked(t, true), [["r1", "accepted"], ["r2", "accepted"]]);
});

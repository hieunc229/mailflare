import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calPubRt.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(env,request,scope){const s=globalThis.calPubRt;s.scopes.push(scope);return s.user?{user:s.user,key:s.key??null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.calPubRt.audit.push(input)}",
};
const fixtures = [
	await loadFixture({ name: "cal-pub-link", entryPoint: "src/app/api/calendar/freebusy-link/route.ts", mocks }),
	await loadFixture({ name: "cal-pub-feed", entryPoint: "src/app/api/calendar/freebusy/route.ts", mocks }),
];
const [link, feed] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calPubRt; for (const fixture of fixtures) fixture.dispose(); });

const HOUR = 3_600_000;
const secs = (ms) => Math.floor(ms / 1000);
const same = { "Sec-Fetch-Site": "same-origin" };
const as = (id, key = null) => { globalThis.calPubRt.user = id ? { id, timeZone: "UTC", calendarEnabled: true } : null; globalThis.calPubRt.key = key; };
const audit = () => globalThis.calPubRt.audit;
const call = (method, headers = same) => link[method](new Request("https://m.test/api/calendar/freebusy-link", { method, headers }));
const keyRows = (user = "u1") => sqlite.prepare("SELECT id, scopes, kind FROM api_keys WHERE user_id = ?").all(user);
const fetchFeed = (key, extra = "") => feed.GET(new Request(`https://m.test/api/calendar/freebusy?key=${encodeURIComponent(key)}${extra}`));

function setup() {
	sqlite?.close();
	sqlite = installSqlite("calPubRt", { schema, extra: { user: null, key: null, audit: [], scopes: [] } });
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'User', 'x', 'user', 1)`);
	as("u1");
}
function busy(user, fromMs, toMs, id = `e${fromMs}`, extra = "") {
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, description, location, attendees, starts_at, ends_at, created_at, updated_at${extra ? ", is_private" : ""}) VALUES ('${id}', '${user}', 'Therapy', 'Notes', 'Clinic', 'doc@x.test', ${secs(fromMs)}, ${secs(toMs)}, 1, 1${extra ? ", 1" : ""})`);
}
async function publish(user = "u1") {
	as(user);
	return (await (await call("POST")).json());
}

test("turning it on makes one key with exactly the freebusy scope and returns the secret once; turning it on again returns no second key", async () => {
	setup();
	const first = await call("POST");
	assert.equal(first.status, 200);
	const body = await first.json();
	assert.equal(body.created, true);
	assert.match(body.key, /^ep_/);
	assert.deepEqual(keyRows().map((row) => row.scopes), ['["calendar:freebusy"]']);
	const again = await (await call("POST")).json();
	assert.deepEqual([again.enabled, again.created, again.key], [true, false, undefined]);
	assert.equal(keyRows().length, 1);
	assert.deepEqual(audit().map((entry) => [entry.action, entry.actorUserId, entry.targetUserId]), [["calendar.freebusy_published", "u1", "u1"]], "only the first turn-on is audited");
	assert.ok(!JSON.stringify(audit()).includes(body.key), "the secret is never in the audit log");
});

test("two requests racing to turn it on end with one key, and exactly one of them holds the secret", async () => {
	setup();
	const results = await Promise.all([call("POST"), call("POST"), call("POST")]);
	const bodies = await Promise.all(results.map((response) => response.json()));
	assert.equal(keyRows().length, 1);
	assert.equal(bodies.filter((body) => body.created).length, 1);
	assert.equal(audit().length, 1);
});

test("GET says whether the link is on, without ever returning the secret or its hash", async () => {
	setup();
	assert.deepEqual(await (await call("GET")).json(), { enabled: false });
	const { key } = await publish();
	const status = await (await call("GET")).json();
	assert.equal(status.enabled, true);
	assert.equal(typeof status.createdAt, "string");
	assert.ok(!JSON.stringify(status).includes(key));
	assert.doesNotMatch(JSON.stringify(status), /hash|sha256|ep_/i);
	as("u2");
	assert.deepEqual(await (await call("GET")).json(), { enabled: false }, "another user's link is not mine");
});

test("turning it off deletes the key, audits it once, and the link stops working", async () => {
	setup();
	const { key } = await publish();
	assert.equal((await fetchFeed(key)).status, 200);
	assert.equal((await call("DELETE")).status, 200);
	assert.equal(keyRows().length, 0);
	assert.equal((await fetchFeed(key)).status, 401);
	assert.equal((await call("DELETE")).status, 200, "turning off twice is fine");
	assert.deepEqual(audit().map((entry) => entry.action), ["calendar.freebusy_published", "calendar.freebusy_unpublished"]);
	const again = await (await call("POST")).json();
	assert.equal(again.created, true, "can be turned on afterwards, with a new secret");
	assert.notEqual(again.key, key);
});

test("an API key, whatever its scope, cannot create, show or delete the publish key; a cross-site request cannot either", async () => {
	setup();
	as("u1", { scopes: ["calendar:write"] });
	for (const method of ["GET", "POST", "DELETE"]) assert.equal((await call(method)).status, 403, method);
	assert.equal(keyRows().length, 0);
	as("u1");
	const { key } = await publish();
	as("u1", { scopes: ["calendar:write", "calendar:read"] });
	assert.equal((await call("DELETE")).status, 403);
	assert.equal(keyRows().length, 1);
	as("u1");
	assert.equal((await call("DELETE", { "Sec-Fetch-Site": "cross-site" })).status, 403);
	assert.equal((await call("POST", { "Sec-Fetch-Site": "cross-site" })).status, 403);
	assert.equal(keyRows().length, 1);
	assert.equal((await fetchFeed(key)).status, 200);
	as(null);
	assert.equal((await call("POST")).status, 401);
});

test("the general key route cannot mint this scope, so the publish key is the only way to get one", async () => {
	const source = readFileSync(new URL("../src/lib/api/scopes.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /calendar:freebusy/);
});

test("GET /freebusy returns an .ifb VFREEBUSY with the busy times and nothing of the events", async () => {
	setup();
	const now = Date.now();
	busy("u1", now + 24 * HOUR, now + 25 * HOUR, "a");
	busy("u1", now + 48 * HOUR, now + 49 * HOUR, "p", "private");
	busy("u2", now + 72 * HOUR, now + 73 * HOUR, "other");
	const { key } = await publish();
	const response = await fetchFeed(key);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("Content-Type"), /^text\/calendar; charset=utf-8/);
	assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="freebusy.ifb"');
	assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
	assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
	const body = await response.text();
	assert.match(body, /^BEGIN:VCALENDAR\r\n/);
	assert.equal((body.match(/^FREEBUSY;FBTYPE=BUSY:/gm) ?? []).length, 2, "the private event is busy, the other user's event is not mine");
	assert.doesNotMatch(body, /Therapy|Notes|Clinic|doc@x|ATTENDEE|SUMMARY|u1@|User/);
});

test("format=ics is busy-only VEVENTs; an unknown format is refused", async () => {
	setup();
	const now = Date.now();
	busy("u1", now + 24 * HOUR, now + 25 * HOUR, "a");
	const { key } = await publish();
	const response = await fetchFeed(key, "&format=ics");
	assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="freebusy.ics"');
	const body = await response.text();
	assert.equal((body.match(/^BEGIN:VEVENT/gm) ?? []).length, 1);
	assert.match(body, /\r\nSUMMARY:Busy\r\n/);
	assert.doesNotMatch(body, /Therapy|Notes|Clinic|doc@x/);
	assert.equal((await fetchFeed(key, "&format=ifb")).status, 200);
	assert.equal((await fetchFeed(key, "&format=pdf")).status, 400);
});

test("the window is the past week and the next 8 weeks", async () => {
	setup();
	const now = Date.now();
	const DAY = 24 * HOUR;
	busy("u1", now - 6 * DAY, now - 6 * DAY + HOUR, "in-past");
	busy("u1", now - 9 * DAY, now - 9 * DAY + HOUR, "too-old");
	busy("u1", now + 55 * DAY, now + 55 * DAY + HOUR, "far");
	busy("u1", now + 58 * DAY, now + 58 * DAY + HOUR, "too-far");
	const { key } = await publish();
	assert.equal(((await (await fetchFeed(key)).text()).match(/^FREEBUSY;/gm) ?? []).length, 2);
});

test("every way of not having a valid link answers the same 401: no key, a wrong one, a mail key, a read key, a wildcard key, a key with the scope among others, a disabled owner, Calendar off", async () => {
	setup();
	const { key } = await publish();
	// keys whose sha256 equals the digest of a known secret
	const { createHash } = await import("node:crypto");
	const plant = (secret, scopes) => sqlite.exec(`INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, scopes, created_at) VALUES ('p${secret}', 'u1', 'k', 'ep_', 'x', '${createHash("sha256").update(secret).digest("hex")}', '${scopes}', 1)`);
	plant("readkey", '["calendar:read"]');
	plant("wild", '["*"]');
	plant("both", '["calendar:freebusy","calendar:read"]');
	plant("empty", "[]");
	const refused = [];
	for (const candidate of ["", "nope", "readkey", "wild", "both", "empty", `${key}x`]) refused.push(await fetchFeed(candidate));
	sqlite.exec("UPDATE users SET disabled = 1 WHERE id = 'u1'");
	refused.push(await fetchFeed(key));
	sqlite.exec("UPDATE users SET disabled = 0, calendar_enabled = 0 WHERE id = 'u1'");
	refused.push(await fetchFeed(key));
	const bodies = await Promise.all(refused.map(async (response) => `${response.status}|${response.headers.get("Cache-Control")}|${response.headers.get("Content-Type")}|${await response.text()}`));
	assert.equal(new Set(bodies).size, 1, bodies.join("\n"));
	assert.match(bodies[0], /^401\|no-store\|/);
	sqlite.exec("UPDATE users SET calendar_enabled = 1 WHERE id = 'u1'");
	assert.equal((await fetchFeed(key)).status, 200, "and the link works again when the account does");
	assert.equal((await feed.GET(new Request("https://m.test/api/calendar/freebusy"))).status, 401);
});

test("the key is accepted in the query only: an Authorization header alone does not open the route", async () => {
	setup();
	const { key } = await publish();
	const response = await feed.GET(new Request("https://m.test/api/calendar/freebusy", { headers: { Authorization: `Bearer ${key}` } }));
	assert.equal(response.status, 401);
});

test("the publish key is refused by the calendar feed, the events API scopes and every other scope check", async () => {
	setup();
	const { key } = await publish();
	const feedFixture = await loadFixture({ name: "cal-pub-oldfeed", entryPoint: "src/app/api/calendar/feed/route.ts", mocks });
	try {
		const { GET } = await feedFixture.import();
		assert.equal((await GET(new Request(`https://m.test/api/calendar/feed?key=${key}`))).status, 401);
	} finally { feedFixture.dispose(); }
});

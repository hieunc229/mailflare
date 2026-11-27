import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calFbRt.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(env,request,scope){const s=globalThis.calFbRt;s.scopes.push(scope);return s.user?{user:s.user,key:s.key??null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.calFbRt.team}}",
};
const fixture = await loadFixture({ name: "cal-fb-route", entryPoint: "src/app/api/calendar/free-busy/route.ts", mocks });
const { POST } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calFbRt; fixture.dispose(); });

const DAY = 86_400_000;
const T0 = Date.UTC(2030, 0, 7);
const iso = (days, hours = 0) => new Date(T0 + days * DAY + hours * 3_600_000).toISOString();

// u1 viewer; u2 shared a calendar with u1 (free/busy); u3 shared nothing; u4 is disabled; u5 has Calendar off.
function setup() {
	sqlite?.close();
	sqlite = installSqlite("calFbRt", { schema, extra: { user: { id: "u1", calendarEnabled: true }, key: null, team: true, scopes: [] } });
	for (let index = 1; index <= 5; index += 1) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u${index}', 'u${index}@one.test', 'User ${index}', 'x', 'user', 1)`);
	sqlite.exec("UPDATE users SET disabled = 1 WHERE id = 'u4'");
	sqlite.exec("UPDATE users SET calendar_enabled = 0 WHERE id = 'u5'");
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u2', 'calendar', 'Work', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1', 'cal:work', 'u1', 'freebusy', 1)");
	for (const user of ["u1", "u2", "u3", "u4", "u5"]) sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('e_${user}', '${user}', 'Private dentist', ${Math.floor((T0 + 9 * 3_600_000) / 1000)}, ${Math.floor((T0 + 10 * 3_600_000) / 1000)}, 1, 1)`);
}
const post = (body, raw) => POST(new Request("https://m.test/api/calendar/free-busy", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) }));
const ask = async (addresses, extra = {}) => (await post({ addresses, start: iso(0), end: iso(1), ...extra })).json();
const BUSY = { status: "ok", busy: [[iso(0, 9), iso(0, 10)]] };

test("the caller's own address and a calendar-grantor's address answer with busy intervals; strangers, unknown and external addresses answer exactly alike", async () => {
	setup();
	const { results } = await ask(["u1@one.test", "u2@one.test", "u3@one.test", "nobody@one.test", "someone@gmail.com"]);
	assert.deepEqual(results["u1@one.test"], BUSY);
	assert.deepEqual(results["u2@one.test"], BUSY);
	assert.deepEqual(results["u3@one.test"], { status: "unknown" });
	assert.equal(JSON.stringify(results["u3@one.test"]), JSON.stringify(results["nobody@one.test"]), "no oracle for who has an account");
	assert.equal(JSON.stringify(results["u3@one.test"]), JSON.stringify(results["someone@gmail.com"]));
	assert.doesNotMatch(JSON.stringify(results), /dentist/);
});

test("a free/busy-only grant is enough, and a revoked one is not", async () => {
	setup();
	assert.equal((await ask(["u2@one.test"])).results["u2@one.test"].status, "ok");
	sqlite.exec("DELETE FROM calendar_shares");
	assert.equal((await ask(["u2@one.test"])).results["u2@one.test"].status, "unknown");
});

test("organisation-wide free/busy opens every active account with Calendar on, only with the switch and a Team licence", async () => {
	setup();
	sqlite.exec("INSERT INTO app_settings (id, calendar_org_free_busy, updated_at) VALUES ('default', 1, 1) ON CONFLICT(id) DO UPDATE SET calendar_org_free_busy = 1");
	const addresses = ["u3@one.test", "u4@one.test", "u5@one.test"];
	const { results } = await ask(addresses);
	assert.equal(results["u3@one.test"].status, "ok");
	assert.deepEqual(results["u4@one.test"], { status: "unknown" }, "disabled account");
	assert.deepEqual(results["u5@one.test"], { status: "unknown" }, "Calendar turned off");
	globalThis.calFbRt.team = false;
	assert.deepEqual((await ask(["u3@one.test"])).results["u3@one.test"], { status: "unknown" });
	globalThis.calFbRt.team = true;
	sqlite.exec("UPDATE app_settings SET calendar_org_free_busy = 0");
	assert.deepEqual((await ask(["u3@one.test"])).results["u3@one.test"], { status: "unknown" });
});

test("addresses are matched without regard to case or surrounding space, and answered under that normal form", async () => {
	setup();
	const { results } = await ask(["  U2@One.Test ", "u2@one.test"]);
	assert.deepEqual(Object.keys(results), ["u2@one.test"]);
	assert.equal(results["u2@one.test"].status, "ok");
});

test("resourceIds are accepted and ignored for now, and count towards the limit", async () => {
	setup();
	const { results } = await ask(["u1@one.test"], { resourceIds: ["res_1"] });
	assert.deepEqual(Object.keys(results), ["u1@one.test"]);
	assert.equal((await post({ addresses: ["u1@one.test"], resourceIds: Array.from({ length: 50 }, (_, index) => `r${index}`), start: iso(0), end: iso(1) })).status, 400);
	assert.equal((await post({ resourceIds: "res_1", start: iso(0), end: iso(1) })).status, 400);
});

test("the request is bounded: at most 50 addresses, a window of 62 days, valid dates, string addresses", async () => {
	setup();
	const many = (count) => Array.from({ length: count }, (_, index) => `p${index}@one.test`);
	assert.equal((await post({ addresses: many(51), start: iso(0), end: iso(1) })).status, 400);
	assert.equal((await post({ addresses: many(50), start: iso(0), end: iso(1) })).status, 200);
	assert.equal((await post({ addresses: ["u1@one.test"], start: iso(0), end: iso(62) })).status, 200);
	assert.equal((await post({ addresses: ["u1@one.test"], start: iso(0), end: iso(62, 1) })).status, 400);
	assert.equal((await post({ addresses: ["u1@one.test"], start: iso(1), end: iso(1) })).status, 400);
	assert.equal((await post({ addresses: ["u1@one.test"], start: iso(2), end: iso(1) })).status, 400);
	assert.equal((await post({ addresses: ["u1@one.test"], start: "soon", end: iso(1) })).status, 400);
	assert.equal((await post({ addresses: ["u1@one.test"], end: iso(1) })).status, 400);
	assert.equal((await post({ addresses: [42], start: iso(0), end: iso(1) })).status, 400);
	assert.equal((await post({ addresses: "u1@one.test", start: iso(0), end: iso(1) })).status, 400);
	assert.equal((await post(null, "{nope")).status, 400);
});

test("no addresses is an empty answer; the answer is never cached; an API key needs calendar:read", async () => {
	setup();
	const response = await post({ start: iso(0), end: iso(1) });
	assert.deepEqual(await response.json(), { results: {} });
	assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
	assert.ok(globalThis.calFbRt.scopes.every((scope) => scope === "calendar:read"));
	assert.ok(globalThis.calFbRt.scopes.length > 0);
});

test("an unauthenticated caller is refused", async () => {
	setup();
	globalThis.calFbRt.user = null;
	assert.equal((await post({ addresses: ["u1@one.test"], start: iso(0), end: iso(1) })).status, 401);
});

// ---- excludeEventId -----------------------------------------------------------------------------------------------------

const { createHash } = await import("node:crypto");
const copyId = (user, uid) => `inv_${createHash("sha256").update(`${user}\n${uid}`).digest("hex").slice(0, 24)}`;
const seconds = (days, hours) => Math.floor((T0 + days * DAY + hours * 3_600_000) / 1000);
function meeting(owner = "u2", calendar = null) {
	// u2 organises "plan" with u3 (accepted copy); u3 and u1 also have unrelated events at 9:00 (u1's from setup).
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('evt_plan', '${owner}', ${calendar ? `'${calendar}'` : "NULL"}, 'Plan', ${seconds(0, 14)}, ${seconds(0, 15)}, 1, 1)`);
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, response_status, created_at, updated_at) VALUES ('${copyId("u3", "evt_plan@mailflare")}', 'u3', 'Plan', ${seconds(0, 14)}, ${seconds(0, 15)}, 'accepted', 1, 1)`);
}
const PLAN = [iso(0, 14), iso(0, 15)];
const busyOf = (results, address) => results[address].busy;

test("excludeEventId: the organiser editing an event no longer sees it, or its guests' copies of it, as busy", async () => {
	setup();
	globalThis.calFbRt.user = { id: "u2", calendarEnabled: true };
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:u3', 'u3', 'calendar', 'u3', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g9', 'cal:u3', 'u2', 'freebusy', 1)");
	meeting();
	const asked = ["u2@one.test", "u3@one.test"];
	const without = (await ask(asked)).results;
	assert.ok(busyOf(without, "u3@one.test").some((pair) => pair.join() === PLAN.join()), "counted before");
	const { results } = await ask(asked, { excludeEventId: "evt_plan" });
	assert.deepEqual(busyOf(results, "u3@one.test"), [BUSY.busy[0]], "only the unrelated 9:00 event is left");
	assert.ok(!busyOf(results, "u2@one.test").some((pair) => pair.join() === PLAN.join()));
});

test("excludeEventId also takes the occurrence form of an id (`<series>@<start>`)", async () => {
	setup();
	globalThis.calFbRt.user = { id: "u2", calendarEnabled: true };
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:u3', 'u3', 'calendar', 'u3', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g9', 'cal:u3', 'u2', 'freebusy', 1)");
	meeting();
	const { results } = await ask(["u3@one.test"], { excludeEventId: `evt_plan@${T0 + 14 * 3_600_000}` });
	assert.deepEqual(busyOf(results, "u3@one.test"), [BUSY.busy[0]]);
});

test("excludeEventId is ignored, without a trace, when the caller cannot edit that event: no role, a read role, a missing event all answer as if it was not sent", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:plans', 'u2', 'calendar', 'Plans', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g8', 'cal:plans', 'u1', 'read', 1)");
	meeting("u2", "cal:plans");
	// u1 holds a free/busy grant on u2 (setup), so u2's 14:00 plan shows as busy to u1, who may not edit it.
	const baseline = JSON.stringify((await ask(["u2@one.test"])).results);
	assert.match(baseline, /T14:00:00/);
	for (const id of ["evt_plan", "evt_missing", `evt_plan@${T0}`]) assert.equal(JSON.stringify((await ask(["u2@one.test"], { excludeEventId: id })).results), baseline, id);
	sqlite.exec("UPDATE calendar_shares SET role = 'edit' WHERE id = 'g8'");
	assert.doesNotMatch(JSON.stringify((await ask(["u2@one.test"], { excludeEventId: "evt_plan" })).results), /T14:00:00/, "an editor may");
});

test("excludeEventId must be text", async () => {
	setup();
	assert.equal((await post({ addresses: ["u1@one.test"], start: iso(0), end: iso(1), excludeEventId: 7 })).status, 400);
});

test("excludeEventId: the owner's CalDAV UID is honoured, an editor's request never reads it; the @mailflare copies go for both", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:u3', 'u3', 'calendar', 'u3', 1, 1), ('cal:plans', 'u2', 'calendar', 'Plans', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g9', 'cal:u3', 'u2', 'freebusy', 1), ('g10', 'cal:u3', 'u1', 'freebusy', 1), ('g11', 'cal:plans', 'u1', 'edit', 1)");
	meeting("u2", "cal:plans");
	sqlite.exec("INSERT INTO dav_calendar_objects (id, user_id, collection_id, name, uid, size, created_at, updated_at) VALUES ('evt_plan', 'u2', 'cal:plans', 'p.ics', 'phone-uid', 0, 1, 1)");
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('${copyId("u3", "phone-uid")}', 'u3', 'Plan', ${seconds(0, 14)}, ${seconds(0, 15)}, 1, 1)`);
	const planOf = async () => busyOf((await ask(["u3@one.test"], { excludeEventId: "evt_plan" })).results, "u3@one.test").some((pair) => pair.join() === PLAN.join());
	globalThis.calFbRt.user = { id: "u2", calendarEnabled: true };
	assert.equal(await planOf(), false, "owner: both copies gone");
	globalThis.calFbRt.user = { id: "u1", calendarEnabled: true };
	assert.equal(await planOf(), true, "an editor leaves out the @mailflare copy only; the copy keyed by the phone's UID stays");
});

test("excludeEventId with an occurrence id leaves out that occurrence and every later one, as the save will move them; earlier ones stay", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:u3', 'u3', 'calendar', 'u3', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g9', 'cal:u3', 'u2', 'freebusy', 1)");
	globalThis.calFbRt.user = { id: "u2", calendarEnabled: true };
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, repeat, starts_at, ends_at, created_at, updated_at) VALUES ('evt_wk', 'u2', 'Wk', 'weekly', ${seconds(0, 16)}, ${seconds(0, 17)}, 1, 1)`);
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, repeat, starts_at, ends_at, response_status, created_at, updated_at) VALUES ('${copyId("u3", "evt_wk@mailflare")}', 'u3', 'Wk', 'weekly', ${seconds(0, 16)}, ${seconds(0, 17)}, 'accepted', 1, 1)`);
	const sixteen = (days) => [iso(days, 16), iso(days, 17)].join();
	const days = async (extra) => { const out = busyOf((await post({ addresses: ["u3@one.test"], start: iso(0), end: iso(22), ...extra }).then((r) => r.json())).results, "u3@one.test"); return out.map((pair) => pair.join()); };
	assert.ok((await days({})).includes(sixteen(7)));
	const from = await days({ excludeEventId: `evt_wk@${T0 + 7 * DAY + 16 * 3_600_000}` });
	assert.ok(from.includes(sixteen(0)), "the earlier occurrence stays");
	assert.ok(!from.includes(sixteen(7)) && !from.includes(sixteen(14)) && !from.includes(sixteen(21)), "it and every later one go");
});

test("excludeEventId with an occurrence id of a series that keeps a custom rule leaves out the whole series, which is how it is saved", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:u3', 'u3', 'calendar', 'u3', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g9', 'cal:u3', 'u2', 'freebusy', 1)");
	globalThis.calFbRt.user = { id: "u2", calendarEnabled: true };
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, repeat, rrule, time_zone, starts_at, ends_at, created_at, updated_at) VALUES ('evt_cu', 'u2', 'Cu', 'custom', 'FREQ=WEEKLY;INTERVAL=1', 'UTC', ${seconds(0, 16)}, ${seconds(0, 17)}, 1, 1)`);
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, repeat, rrule, time_zone, starts_at, ends_at, response_status, created_at, updated_at) VALUES ('${copyId("u3", "evt_cu@mailflare")}', 'u3', 'Cu', 'custom', 'FREQ=WEEKLY;INTERVAL=1', 'UTC', ${seconds(0, 16)}, ${seconds(0, 17)}, 'accepted', 1, 1)`);
	const sixteen = (days) => [iso(days, 16), iso(days, 17)].join();
	const days = async (extra) => (busyOf((await post({ addresses: ["u3@one.test"], start: iso(0), end: iso(22), ...extra }).then((r) => r.json())).results, "u3@one.test")).map((pair) => pair.join());
	assert.ok((await days({})).includes(sixteen(0)));
	const out = await days({ excludeEventId: `evt_cu@${T0 + 7 * DAY + 16 * 3_600_000}` });
	assert.ok(!out.includes(sixteen(0)) && !out.includes(sixteen(7)), "the first occurrence goes too");
});

// ---- A moved row's own id ------------------------------------------------------------------------------------------------

function weeklyWithMovedRow(caller = "u2") {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:u3', 'u3', 'calendar', 'u3', 1, 1), ('cal:wk', 'u2', 'calendar', 'Wk', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g9', 'cal:u3', 'u2', 'freebusy', 1), ('g10', 'cal:u3', 'u1', 'freebusy', 1)");
	globalThis.calFbRt.user = { id: caller, calendarEnabled: true };
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, calendar_id, title, repeat, excluded_occurrences, starts_at, ends_at, created_at, updated_at) VALUES ('evt_wk', 'u2', 'cal:wk', 'Wk', 'weekly', '[${(T0 + 7 * DAY + 16 * 3_600_000)}]', ${seconds(0, 16)}, ${seconds(0, 17)}, 1, 1)`);
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, dav_object_id, recurrence_id, created_at, updated_at) VALUES ('evt_wk_ov', 'u2', 'cal:wk', 'Moved', ${seconds(7, 20)}, ${seconds(7, 21)}, 'evt_wk', ${seconds(7, 16)}, 1, 1)`);
	// u3 holds copies of the series and of the moved row (each invitation carries <id>@mailflare).
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, repeat, starts_at, ends_at, response_status, created_at, updated_at) VALUES ('${copyId("u3", "evt_wk@mailflare")}', 'u3', 'Wk', 'weekly', ${seconds(0, 16)}, ${seconds(0, 17)}, 'accepted', 1, 1)`);
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, response_status, created_at, updated_at) VALUES ('${copyId("u3", "evt_wk_ov@mailflare")}', 'u3', 'Moved', ${seconds(7, 20)}, ${seconds(7, 21)}, 'accepted', 1, 1)`);
}
const dayPairs = async (extra) => busyOf((await post({ addresses: ["u3@one.test"], start: iso(0), end: iso(15), ...extra }).then((r) => r.json())).results, "u3@one.test").map((pair) => pair.join());

test("a moved row's own id leaves out that row and the guests' copies of it, and nothing of the series", async () => {
	weeklyWithMovedRow();
	const slot = (days, from, to) => [iso(days, from), iso(days, to)].join();
	const before = await dayPairs({});
	assert.ok(before.includes(slot(7, 20, 21)) && before.includes(slot(0, 16, 17)) && before.includes(slot(14, 16, 17)));
	const out = await dayPairs({ excludeEventId: "evt_wk_ov" });
	assert.ok(!out.includes(slot(7, 20, 21)), "the moved row's copy goes");
	assert.ok(out.includes(slot(0, 16, 17)) && out.includes(slot(14, 16, 17)), "the series stays");
});

test("a moved row needs the right to edit its series too, or the field is ignored without a trace", async () => {
	weeklyWithMovedRow("u1");
	// u1 may edit the moved row's calendar only through a grant on cal:wk; give edit on the row's calendar... the series lives in the same calendar, so move the series elsewhere.
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:other', 'u2', 'calendar', 'Other', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g11', 'cal:wk', 'u1', 'edit', 1)");
	sqlite.exec("UPDATE calendar_events SET calendar_id = 'cal:other' WHERE id = 'evt_wk'");
	const baseline = JSON.stringify(await dayPairs({}));
	assert.equal(JSON.stringify(await dayPairs({ excludeEventId: "evt_wk_ov" })), baseline, "edit on the row's calendar alone is not enough");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g12', 'cal:other', 'u1', 'edit', 1)");
	assert.notEqual(JSON.stringify(await dayPairs({ excludeEventId: "evt_wk_ov" })), baseline);
});

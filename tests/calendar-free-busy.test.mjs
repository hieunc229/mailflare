import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";
import { readFileSync } from "node:fs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");

const mocks = {
	"@/db": "export function getDb(){return globalThis.calFb.db}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.calFb.team}}",
};
const service = await loadFixture({ name: "cal-fb-service", entryPoint: "src/lib/calendar/free-busy.ts", mocks });
const access = await loadFixture({ name: "cal-fb-access", entryPoint: "src/lib/calendar/free-busy-access.ts", mocks });
const { busyIntervals, mergeBusy, MAX_FREE_BUSY_IDS, MAX_FREE_BUSY_DAYS } = await service.import();
const { isOrgFreeBusyEnabled, resolveFreeBusyAddresses, viewableFreeBusyUsers } = await access.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calFb; service.dispose(); access.dispose(); });

const DAY = 86_400_000;
const H = 3_600_000;
const T0 = Date.UTC(2030, 0, 7); // a Monday
const at = (days, hours = 0) => T0 + days * DAY + hours * H;
let statements;

function setup(users = 6) {
	sqlite?.close();
	statements = [];
	sqlite = installSqlite("calFb", { schema, extra: { team: true }, beforeQuery: (sql) => statements.push(sql) });
	for (let index = 1; index <= users; index += 1) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u${index}', 'u${index}@one.test', 'User ${index}', 'x', 'user', 1)`);
	return sqlite;
}
const secs = (ms) => Math.floor(ms / 1000);
let counter = 0;
function event(user, start, end, extra = {}) {
	const row = { id: `e${++counter}`, calendar_id: null, repeat: "none", repeat_days: "[]", excluded_occurrences: "[]", transparent: 0, is_private: 0, response_status: null, rrule: null, time_zone: "UTC", repeat_until: null, dav_object_id: null, recurrence_id: null, ...extra };
	const columns = ["id", "user_id", "title", "starts_at", "ends_at", "created_at", "updated_at", ...Object.keys(row).filter((key) => key !== "id")];
	const values = [row.id, user, "Secret title", secs(start), secs(end), 1, 1, ...Object.entries(row).filter(([key]) => key !== "id").map(([, value]) => value)];
	sqlite.prepare(`INSERT INTO calendar_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
	return row.id;
}
const win = (from, to) => [new Date(from), new Date(to)];
const busy = async (users, from, to, resourceIds) => busyIntervals({}, { userIds: users, ...(resourceIds ? { resourceIds } : {}) }, ...win(from, to));
const paramCounts = () => statements.map((sql) => (sql.match(/\?/g) ?? []).length);

test("mergeBusy sorts, merges overlapping and touching intervals, and drops empty ones", () => {
	assert.deepEqual(mergeBusy([[5, 9], [1, 3], [3, 4], [8, 12], [20, 20]]), [[1, 4], [5, 12]]);
	assert.deepEqual(mergeBusy([]), []);
});

test("busyIntervals: a one-off event is a busy interval clamped to the window; everyone asked for has an entry", async () => {
	setup();
	event("u1", at(0, 9), at(0, 10));
	event("u1", at(1, 23), at(2, 2));
	event("u2", at(0, 9), at(0, 10));
	const result = await busy(["u1", "u3"], at(0), at(2));
	assert.deepEqual([...result.keys()], ["u1", "u3"]);
	assert.deepEqual(result.get("u1"), [[at(0, 9), at(0, 10)], [at(1, 23), at(2)]]);
	assert.deepEqual(result.get("u3"), []);
	assert.equal(result.has("u2"), false, "only the people asked about");
});

test("busyIntervals: overlapping and back-to-back events merge", async () => {
	setup();
	event("u1", at(0, 9), at(0, 10));
	event("u1", at(0, 9.5), at(0, 11));
	event("u1", at(0, 11), at(0, 12));
	assert.deepEqual((await busy(["u1"], at(0), at(1))).get("u1"), [[at(0, 9), at(0, 12)]]);
});

test("busyIntervals: transparent events, unanswered invitations and declined or cancelled ones are not busy; accepted, tentative and own events are", async () => {
	setup();
	event("u1", at(0, 1), at(0, 2), { transparent: 1 });
	event("u1", at(0, 2), at(0, 3), { response_status: "needs-action" });
	event("u1", at(0, 3), at(0, 4), { response_status: "declined" });
	event("u1", at(0, 4), at(0, 5), { response_status: "cancelled" });
	event("u1", at(0, 6), at(0, 7), { response_status: "accepted" });
	event("u1", at(0, 8), at(0, 9), { response_status: "tentative" });
	event("u1", at(0, 10), at(0, 11));
	assert.deepEqual((await busy(["u1"], at(0), at(1))).get("u1"), [[at(0, 6), at(0, 7)], [at(0, 8), at(0, 9)], [at(0, 10), at(0, 11)]]);
});

test("busyIntervals: a private event counts as busy and the result carries nothing but numbers", async () => {
	setup();
	event("u1", at(0, 9), at(0, 10), { is_private: 1 });
	const result = await busy(["u1"], at(0), at(1));
	assert.deepEqual(result.get("u1"), [[at(0, 9), at(0, 10)]]);
	assert.doesNotMatch(JSON.stringify([...result]), /Secret/);
});

test("busyIntervals: every calendar the person owns counts, not just the default one", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1)");
	event("u1", at(0, 9), at(0, 10), { calendar_id: "cal:work" });
	event("u1", at(0, 11), at(0, 12));
	assert.deepEqual((await busy(["u1"], at(0), at(1))).get("u1"), [[at(0, 9), at(0, 10)], [at(0, 11), at(0, 12)]]);
});

test("busyIntervals: a weekly series that began months ago is expanded inside the window, with its exclusions", async () => {
	setup();
	const start = at(-70, 9);
	event("u1", start, start + H, { repeat: "weekly", excluded_occurrences: JSON.stringify([start + 77 * DAY]) });
	// Occurrences fall every 7 days from day -70: -63 ... 0, 7 ... Window days 0..16 contains days 0, 7 (excluded: -70 + 77 = 7), 14.
	assert.deepEqual((await busy(["u1"], at(0), at(16))).get("u1"), [[at(0, 9), at(0, 10)], [at(14, 9), at(14, 10)]]);
});

test("busyIntervals: a moved occurrence (override row) is busy at its new time and the original time is free", async () => {
	setup();
	const start = at(-14, 9);
	const master = event("u1", start, start + H, { repeat: "weekly", excluded_occurrences: JSON.stringify([at(7, 9)]) });
	event("u1", at(7, 15), at(7, 16), { dav_object_id: master, recurrence_id: secs(at(7, 9)) });
	assert.deepEqual((await busy(["u1"], at(6), at(9))).get("u1"), [[at(7, 15), at(7, 16)]]);
});

test("busyIntervals: an occurrence that began before the window and runs into it is clamped", async () => {
	setup();
	event("u1", at(-1, 22), at(0, 3), { repeat: "daily" });
	const [first] = (await busy(["u1"], at(0), at(1))).get("u1");
	assert.deepEqual(first, [at(0), at(0, 3)]);
});

test("busyIntervals: a series whose rule is too heavy to expand makes the whole window busy rather than free", async () => {
	setup();
	event("u1", Date.UTC(1700, 0, 3, 9), Date.UTC(1700, 0, 3, 10), { repeat: "custom", rrule: "FREQ=YEARLY;INTERVAL=400;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO", time_zone: "UTC" });
	assert.deepEqual((await busy(["u1"], at(0), at(2))).get("u1"), [[at(0), at(2)]]);
});

test("busyIntervals: resource ids are accepted and ignored until rooms exist", async () => {
	setup();
	event("u1", at(0, 9), at(0, 10));
	const result = await busy(["u1"], at(0), at(1), ["res_1", "res_2"]);
	assert.deepEqual([...result.keys()], ["u1"]);
});

test("busyIntervals: asking about more than 50 people, a window over 62 days, or an empty or inverted window is refused", async () => {
	setup();
	assert.equal(MAX_FREE_BUSY_IDS, 50);
	assert.equal(MAX_FREE_BUSY_DAYS, 62);
	await assert.rejects(busy(Array.from({ length: 51 }, (_, index) => `x${index}`), at(0), at(1)), RangeError);
	await assert.rejects(busy(["u1"], at(0), at(62, 1)), RangeError);
	await assert.rejects(busy(["u1"], at(1), at(1)), RangeError);
	await assert.rejects(busy(["u1"], at(2), at(1)), RangeError);
	await assert.doesNotReject(busy(["u1"], at(0), at(62)));
});

test("busyIntervals: 50 people are read in statements that bind under D1's 100 parameters, and every person's events are found", async () => {
	setup(50);
	for (let index = 1; index <= 50; index += 1) event(`u${index}`, at(0, 9), at(0, 10));
	statements.length = 0;
	const result = await busy(Array.from({ length: 50 }, (_, index) => `u${index + 1}`), at(0), at(1));
	assert.equal(result.size, 50);
	for (const intervals of result.values()) assert.deepEqual(intervals, [[at(0, 9), at(0, 10)]]);
	assert.ok(paramCounts().length > 1, "the read is split into several statements");
	assert.ok(Math.max(...paramCounts()) <= 100, `most parameters in one statement: ${Math.max(...paramCounts())}`);
});

test("busyIntervals: the same person named twice is read once", async () => {
	setup();
	event("u1", at(0, 9), at(0, 10));
	const result = await busy(["u1", "u1"], at(0), at(1));
	assert.equal(result.size, 1);
	assert.deepEqual(result.get("u1"), [[at(0, 9), at(0, 10)]]);
});

// ---- Access (D-10) ----------------------------------------------------------------------------------------------------

const setOrg = (on) => sqlite.exec(`INSERT INTO app_settings (id, calendar_org_free_busy, updated_at) VALUES ('default', ${on ? 1 : 0}, 1) ON CONFLICT(id) DO UPDATE SET calendar_org_free_busy = ${on ? 1 : 0}`);
const visible = async (viewer, targets) => [...await viewableFreeBusyUsers({}, viewer, targets)].sort();

test("access: a person always sees their own free/busy; a stranger sees no one's", async () => {
	setup();
	assert.deepEqual(await visible("u1", ["u1", "u2", "u3"]), ["u1"]);
});

test("access: any grant on any of the owner's calendars opens their free/busy, free/busy-only included; a grant on someone else's does not", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u2', 'calendar', 'Work', 1, 1), ('cal:ops', 'u3', 'calendar', 'Ops', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1', 'cal:work', 'u1', 'freebusy', 1), ('g2', 'cal:ops', 'u4', 'manage', 1)");
	assert.deepEqual(await visible("u1", ["u2", "u3", "u4"]), ["u2"]);
	assert.deepEqual(await visible("u4", ["u2", "u3"]), ["u3"]);
	sqlite.exec("DELETE FROM calendar_shares WHERE id = 'g1'");
	assert.deepEqual(await visible("u1", ["u2"]), [], "a revoked grant stops working at once");
});

test("access: a grant from an owner who is disabled or has Calendar turned off opens nothing", async () => {
	setup();
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u2', 'calendar', 'Work', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g1', 'cal:work', 'u1', 'read', 1)");
	assert.deepEqual(await visible("u1", ["u2"]), ["u2"]);
	sqlite.exec("UPDATE users SET calendar_enabled = 0 WHERE id = 'u2'");
	assert.deepEqual(await visible("u1", ["u2"]), []);
	sqlite.exec("UPDATE users SET calendar_enabled = 1, disabled = 1 WHERE id = 'u2'");
	assert.deepEqual(await visible("u1", ["u2"]), []);
});

test("access: org free/busy needs both the admin switch and a Team licence, and only reaches active accounts with Calendar on", async () => {
	setup();
	assert.equal(await isOrgFreeBusyEnabled({}), false, "off by default, with no settings row");
	assert.deepEqual(await visible("u1", ["u2", "u3"]), []);
	setOrg(true);
	assert.equal(await isOrgFreeBusyEnabled({}), true);
	assert.deepEqual(await visible("u1", ["u2", "u3"]), ["u2", "u3"]);
	sqlite.exec("UPDATE users SET calendar_enabled = 0 WHERE id = 'u2'");
	sqlite.exec("UPDATE users SET disabled = 1 WHERE id = 'u3'");
	assert.deepEqual(await visible("u1", ["u2", "u3", "u4"]), ["u4"]);
	globalThis.calFb.team = false;
	assert.equal(await isOrgFreeBusyEnabled({}), false, "a lapsed licence behaves as off (D-13)");
	assert.deepEqual(await visible("u1", ["u4"]), []);
	globalThis.calFb.team = true;
	setOrg(false);
	assert.deepEqual(await visible("u1", ["u4"]), []);
});

test("access: 50 targets are checked in statements under 100 bound parameters", async () => {
	setup(50);
	setOrg(true);
	statements.length = 0;
	const ids = Array.from({ length: 50 }, (_, index) => `u${index + 1}`);
	assert.equal((await visible("u1", ids)).length, 50);
	assert.ok(Math.max(...paramCounts()) <= 100, `most parameters in one statement: ${Math.max(...paramCounts())}`);
});

// ---- Addresses ----------------------------------------------------------------------------------------------------------

test("resolveFreeBusyAddresses: an account's sign-in address or personal mailbox resolves, any case; shared mailboxes, disabled mailboxes and strangers do not", async () => {
	setup();
	sqlite.exec("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'corp.test', 'z', 1)");
	sqlite.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m1', 'u3', 'd1', 'sam', 'personal', 1), ('m2', 'u4', 'd1', 'team', 'shared', 1)");
	sqlite.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES ('m3', 'u5', 'd1', 'off', 'personal', 1, 1)");
	const map = await resolveFreeBusyAddresses({}, ["u2@one.test", "sam@corp.test", "team@corp.test", "off@corp.test", "nobody@elsewhere.test", "not-an-address", ""]);
	assert.deepEqual([...map].sort(), [["sam@corp.test", "u3"], ["u2@one.test", "u2"]].sort());
});

test("resolveFreeBusyAddresses: 50 addresses resolve in statements under 100 bound parameters", async () => {
	setup(50);
	sqlite.exec("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'corp.test', 'z', 1)");
	for (let index = 1; index <= 25; index += 1) sqlite.exec(`INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m${index}', 'u${index + 25}', 'd1', 'p${index}', 'personal', 1)`);
	const addresses = [...Array.from({ length: 25 }, (_, index) => `u${index + 1}@one.test`), ...Array.from({ length: 25 }, (_, index) => `p${index + 1}@corp.test`)];
	statements.length = 0;
	const map = await resolveFreeBusyAddresses({}, addresses);
	assert.equal(map.size, 50);
	assert.equal(map.get("p7@corp.test"), "u32");
	assert.ok(Math.max(...paramCounts()) <= 100, `most parameters in one statement: ${Math.max(...paramCounts())}`);
});

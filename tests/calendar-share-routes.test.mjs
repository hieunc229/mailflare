import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calShareRt.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){const s=globalThis.calShareRt;return s.user?{user:s.user,key:null,error:null}:{user:null,key:null,error:Response.json({error:'Unauthorized'},{status:401})}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.calShareRt.audit.push(input)}",
};
const load = (name, entryPoint) => loadFixture({ name, entryPoint, mocks });
const fixtures = [
	await load("cal-share-list", "src/app/api/calendar/calendars/route.ts"),
	await load("cal-share-item", "src/app/api/calendar/calendars/[id]/route.ts"),
	await load("cal-share-shares", "src/app/api/calendar/calendars/[id]/shares/route.ts"),
];
const [{ GET: listCalendars }, { PATCH: patchCalendar, DELETE: deleteCalendar }, { GET: listShares, POST: postShare, PATCH: patchShare, DELETE: deleteShare }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calShareRt; for (const fixture of fixtures) fixture.dispose(); });

// u1 owns "cal:work" (and a default calendar); u2 edit, u3 read, u4 free/busy, u5 manage; u6 nothing.
function setup() {
	sqlite?.close();
	sqlite = installSqlite("calShareRt", { schema, extra: { user: null, audit: [] } });
	globalThis.calShareRt.db.batch = async (statements) => {
		sqlite.exec("BEGIN");
		try { for (const statement of statements) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
	};
	for (let index = 1; index <= 6; index += 1) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u${index}', 'u${index}@one.test', 'User ${index}', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1)");
	for (const [id, user, role] of [["g2", "u2", "edit"], ["g3", "u3", "read"], ["g4", "u4", "freebusy"], ["g5", "u5", "manage"]]) sqlite.exec(`INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('${id}', 'cal:work', '${user}', '${role}', 1)`);
	as("u1");
}
const as = (id) => { globalThis.calShareRt.user = { id, timeZone: "UTC", calendarEnabled: true }; };
const audit = () => globalThis.calShareRt.audit;
const json = (body, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id) => ({ params: Promise.resolve({ id: encodeURIComponent(id) }) });
const url = "https://m.test/api/calendar/calendars/cal%3Awork";
const rolesOf = () => sqlite.prepare("SELECT grantee_user_id AS u, role FROM calendar_shares WHERE calendar_id = 'cal:work' ORDER BY grantee_user_id").all().map((row) => `${row.u}:${row.role}`);

test("GET /calendars lists the user's own calendars and those shared with them with the role, hiding free/busy grants", async () => {
	setup();
	as("u2");
	const { calendars } = await (await listCalendars(new Request("https://m.test/api/calendar/calendars"))).json();
	assert.deepEqual(calendars.map((calendar) => [calendar.id, calendar.role]), [["cal:u2", "owner"], ["cal:work", "edit"]]);
	assert.equal(calendars[1].ownerName, "User 1");
	as("u4");
	assert.deepEqual((await (await listCalendars(new Request("https://m.test/x"))).json()).calendars.map((calendar) => calendar.id), ["cal:u4"]);
});

test("PATCH /calendars/:id: a manager may rename the calendar and is audited as the actor; an editor, reader, free/busy grantee and stranger may not", async () => {
	setup();
	as("u5");
	const response = await patchCalendar(new Request(url, json({ name: "Team" }, "PATCH")), params("cal:work"));
	assert.equal(response.status, 200);
	const { calendar } = await response.json();
	assert.deepEqual([calendar.name, calendar.role, calendar.isDefault], ["Team", "manage", false]);
	assert.equal(sqlite.prepare("SELECT display_name AS n FROM dav_collections WHERE id = 'cal:work'").get().n, "Team");
	assert.deepEqual([audit()[0].action, audit()[0].actorUserId, audit()[0].targetUserId, audit()[0].metadata.calendarId], ["calendar.updated", "u5", "u1", "cal:work"]);
	const statuses = {};
	for (const user of ["u2", "u3", "u4", "u6"]) { as(user); statuses[user] = (await patchCalendar(new Request(url, json({ name: "Hacked" }, "PATCH")), params("cal:work"))).status; }
	assert.deepEqual(statuses, { u2: 403, u3: 403, u4: 404, u6: 404 });
	assert.equal(sqlite.prepare("SELECT display_name AS n FROM dav_collections WHERE id = 'cal:work'").get().n, "Team");
});

test("DELETE /calendars/:id is the owner's alone: a manager is 403 and the calendar, its events and its grants stay", async () => {
	setup();
	sqlite.exec("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'u1', 'cal:work', 'E', 1, 2, 1, 1)");
	as("u5");
	assert.equal((await deleteCalendar(new Request(url, json({ confirm: true }, "DELETE")), params("cal:work"))).status, 403);
	as("u6");
	assert.equal((await deleteCalendar(new Request(url, json({ confirm: true }, "DELETE")), params("cal:work"))).status, 404);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
	assert.equal(rolesOf().length, 4);
	as("u1");
	assert.equal((await deleteCalendar(new Request(url, json({ confirm: true }, "DELETE")), params("cal:work"))).status, 200);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_shares").get().n, 0, "deleting a calendar removes its grants");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
});

test("GET /shares: owner and manager see the grants; others do not, and the stranger gets 404", async () => {
	setup();
	const get = (user) => { as(user); return listShares(new Request(`${url}/shares`), params("cal:work")); };
	const body = await (await get("u1")).json();
	assert.deepEqual(body.shares.map((share) => [share.email, share.role]), [["u2@one.test", "edit"], ["u3@one.test", "read"], ["u4@one.test", "freebusy"], ["u5@one.test", "manage"]]);
	assert.equal((await get("u5")).status, 200);
	assert.deepEqual([(await get("u2")).status, (await get("u3")).status, (await get("u4")).status, (await get("u6")).status], [403, 403, 404, 404]);
});

test("POST /shares grants a role by email and audits it; errors are statuses, not leaks", async () => {
	setup();
	const post = (body) => postShare(new Request(`${url}/shares`, json(body)), params("cal:work"));
	const ok = await post({ email: "u6@one.test", role: "read" });
	assert.equal(ok.status, 200);
	const { share } = await ok.json();
	assert.deepEqual([share.userId, share.role], ["u6", "read"]);
	assert.deepEqual([audit()[0].action, audit()[0].actorUserId, audit()[0].targetUserId, audit()[0].metadata.calendarId, audit()[0].metadata.granteeUserId, audit()[0].metadata.role, audit()[0].metadata.shareId], ["calendar.share_granted", "u1", "u1", "cal:work", "u6", "read", share.id]);
	assert.equal((await post({ email: "u6@one.test", role: "edit" })).status, 409);
	assert.equal((await post({ email: "ghost@one.test", role: "edit" })).status, 404);
	assert.equal((await post({ email: "u1@one.test", role: "edit" })).status, 400);
	assert.equal((await post({ email: "u3@one.test", role: "root" })).status, 400);
	assert.equal(audit().length, 1);
	assert.equal((await postShare(new Request(`${url}/shares`, { method: "POST", body: "{" }), params("cal:work"))).status, 400);
	as("u3");
	assert.equal((await post({ email: "u1@one.test", role: "read" })).status, 403);
});

test("PATCH /shares changes a role under a new grant id and audits the previous role; DELETE revokes at once and audits", async () => {
	setup();
	const patch = (body) => patchShare(new Request(`${url}/shares`, json(body, "PATCH")), params("cal:work"));
	const response = await patch({ id: "g2", role: "read" });
	assert.equal(response.status, 200);
	const { share } = await response.json();
	assert.notEqual(share.id, "g2");
	assert.deepEqual([audit()[0].action, audit()[0].metadata.previousRole, audit()[0].metadata.role, audit()[0].metadata.granteeUserId], ["calendar.share_changed", "edit", "read", "u2"]);
	assert.equal((await patch({ id: "g2", role: "edit" })).status, 404);
	const revoke = (body) => deleteShare(new Request(`${url}/shares`, json(body, "DELETE")), params("cal:work"));
	assert.equal((await revoke({ id: share.id })).status, 200);
	assert.deepEqual(rolesOf(), ["u3:read", "u4:freebusy", "u5:manage"]);
	assert.deepEqual([audit()[1].action, audit()[1].metadata.granteeUserId, audit()[1].metadata.role], ["calendar.share_revoked", "u2", "read"]);
	assert.equal((await revoke({})).status, 400);
	assert.equal((await revoke({ id: "g3" })).status, 200, "the id may also come in a JSON body only; a second revoke of the same id is 404");
	assert.equal((await revoke({ id: "g3" })).status, 404);
	as("u3");
	assert.equal((await revoke({ id: "g4" })).status, 404, "a reader whose own grant was just revoked has no calendar any more");
});

test("the share routes need a signed-in user", async () => {
	setup();
	globalThis.calShareRt.user = null;
	assert.equal((await listShares(new Request(`${url}/shares`), params("cal:work"))).status, 401);
	assert.equal((await postShare(new Request(`${url}/shares`, json({ email: "u2@one.test", role: "read" })), params("cal:work"))).status, 401);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, gte, lt, ne, or } from "drizzle-orm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-cal-share-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { shares: join(root, "src/lib/calendar/shares.ts"), visibility: join(root, "src/lib/calendar/visibility.ts"), schema: join(root, "src/db/schema/index.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@": join(root, "src") },
	external: ["better-sqlite3", "pg", "postgres", "mysql2", "@neondatabase/serverless", "@planetscale/database", "@libsql/client", "@electric-sql/pglite", "bun:sqlite", "cloudflare:workers"],
});
const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const shares = await load("shares");
const { redactEvent, isBusyEvent } = await load("visibility");
const { calendarEvents } = await load("schema");
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function setup() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	for (const id of ["u1", "u2", "u3", "u4"]) sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'x', 'user', 1)").run(id, `${id}@one.test`, `User ${id}`);
	const statements = [];
	const orm = drizzle(sqlite, { logger: { logQuery: (query, params) => statements.push({ query, params }) } });
	orm.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	const calendar = (id, owner = "u1", name = "Work") => sqlite.prepare("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES (?, ?, 'calendar', ?, 1, 1)").run(id, owner, name);
	const grant = (id, calendarId, user, role) => sqlite.prepare("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES (?, ?, ?, ?, 1)").run(id, calendarId, user, role);
	const event = (id, owner = "u1", calendarId = null, extra = "") => sqlite.prepare(`INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, 'T ${extra}', 1000, 2000, 1, 1)`).run(id, owner, calendarId);
	return { sqlite, orm, statements, calendar, grant, event };
}
const u = (id) => ({ id });

test("getCalendarRole: owner is implicit, grantees get their role, everyone else gets null", async () => {
	const { orm, calendar, grant } = setup();
	calendar("cal:work"); grant("g1", "cal:work", "u2", "edit");
	assert.equal(await shares.getCalendarRole(orm, u("u1"), "cal:work"), "owner");
	assert.equal(await shares.getCalendarRole(orm, u("u1"), "cal:u1"), "owner", "the default calendar has no row yet");
	assert.equal(await shares.getCalendarRole(orm, u("u2"), "cal:work"), "edit");
	assert.equal(await shares.getCalendarRole(orm, u("u3"), "cal:work"), null);
	assert.equal(await shares.getCalendarRole(orm, u("u2"), "cal:u1"), null, "no row, so nothing can be granted");
	assert.equal(await shares.getCalendarRole(orm, u("u2"), "cal:missing"), null);
});

test("getCalendarRole: a revoked grant stops working at once, and a disabled owner's calendars are closed to grantees", async () => {
	const { sqlite, orm, calendar, grant } = setup();
	calendar("cal:work"); grant("g1", "cal:work", "u2", "manage");
	assert.equal(await shares.getCalendarRole(orm, u("u2"), "cal:work"), "manage");
	sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
	assert.equal(await shares.getCalendarRole(orm, u("u2"), "cal:work"), null);
	assert.equal(await shares.getCalendarRole(orm, u("u1"), "cal:work"), "owner", "the owner's own access is the session's business");
	sqlite.prepare("UPDATE users SET disabled = 0 WHERE id = 'u1'").run();
	sqlite.prepare("DELETE FROM calendar_shares WHERE id = 'g1'").run();
	assert.equal(await shares.getCalendarRole(orm, u("u2"), "cal:work"), null);
});

test("getEventAccess: role comes from the event's calendar, and a row that breaks the owner invariant gives nobody access", async () => {
	const { orm, calendar, grant, event } = setup();
	calendar("cal:work"); calendar("cal:u1", "u1", null); grant("g1", "cal:work", "u2", "read"); grant("g2", "cal:u1", "u3", "edit");
	event("e1", "u1", "cal:work"); event("e2", "u1", null); event("e3", "u1", "cal:gone");
	const row = async (id) => (await orm.select().from(calendarEvents).where(eq(calendarEvents.id, id)))[0];
	assert.equal(await shares.getEventAccess(orm, u("u1"), await row("e1")), "owner");
	assert.equal(await shares.getEventAccess(orm, u("u2"), await row("e1")), "read");
	assert.equal(await shares.getEventAccess(orm, u("u2"), await row("e2")), null, "u2 has no grant on the default calendar");
	assert.equal(await shares.getEventAccess(orm, u("u3"), await row("e2")), "edit", "events with no calendar are in the owner's default calendar");
	assert.equal(await shares.getEventAccess(orm, u("u2"), await row("e3")), null, "a dangling calendar id opens nothing to others");
	// Owner invariant: a row whose user is not its calendar's owner is never reachable through that calendar's grants.
	assert.equal(await shares.getEventAccess(orm, u("u2"), { userId: "u4", calendarId: "cal:work" }), null);
});

test("listVisibleCalendars: own calendars, then calendars shared as read or better, with role and owner; free/busy grants are not listed", async () => {
	const { sqlite, orm, calendar, grant } = setup();
	calendar("cal:mine", "u2", "Mine"); calendar("cal:a", "u1", "A"); calendar("cal:b", "u1", "B"); calendar("cal:c", "u3", "C"); calendar("cal:u1", "u1", null);
	grant("g1", "cal:a", "u2", "read"); grant("g2", "cal:b", "u2", "freebusy"); grant("g3", "cal:u1", "u2", "manage"); grant("g4", "cal:c", "u2", "edit");
	sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u3'").run();
	const list = await shares.listVisibleCalendars(orm, u("u2"));
	assert.deepEqual(list.filter((entry) => entry.role === "owner").map((entry) => entry.id), ["cal:u2", "cal:mine"]);
	const shared = list.filter((entry) => entry.role !== "owner").sort((a, b) => a.id.localeCompare(b.id));
	assert.deepEqual(shared.map((entry) => [entry.id, entry.role, entry.ownerName, entry.isDefault]), [["cal:a", "read", "User u1", false], ["cal:u1", "manage", "User u1", false]]);
});

test("redactEvent: owner and editors see everything, readers lose private details, free/busy sees blocks only", () => {
	const base = { id: "e", userId: "u1", title: "Therapy", description: "d", location: "l", attendees: '["a@b.co"]', attendeeResponses: '{"a@b.co":"accepted"}', mailboxId: "mbx", inviteMessageId: "msg", inviteSender: "boss@elsewhere.test", reminderMinutes: 10, startsAt: new Date(1000), endsAt: new Date(2000), repeat: "weekly", transparent: false, isPrivate: true, responseStatus: null, color: "#000" };
	assert.deepEqual(redactEvent(base, "owner"), base);
	for (const role of ["edit", "manage"]) {
		const view = redactEvent(base, role);
		assert.equal(view.title, "Therapy");
		assert.equal(view.description, "d");
		assert.equal(view.mailboxId, null, "the owner's mailbox is not for delegates");
		assert.equal(view.inviteMessageId, null);
		assert.equal(view.inviteSender, null, "who invited the owner is the owner's business");
		assert.equal(view.reminderMinutes, null);
	}
	const hidden = redactEvent(base, "read");
	assert.deepEqual([hidden.title, hidden.description, hidden.location, hidden.attendees, hidden.attendeeResponses, hidden.mailboxId, hidden.inviteMessageId, hidden.reminderMinutes, hidden.redacted], ["Busy", "", "", "[]", null, null, null, null, true]);
	assert.deepEqual([hidden.startsAt, hidden.endsAt, hidden.repeat, hidden.transparent], [base.startsAt, base.endsAt, "weekly", false]);
	const open = redactEvent({ ...base, isPrivate: false }, "read");
	assert.deepEqual([open.title, open.description, open.attendees, open.redacted], ["Therapy", "d", '["a@b.co"]', undefined]);
	const blocks = redactEvent({ ...base, isPrivate: false }, "freebusy");
	assert.deepEqual([blocks.title, blocks.description, blocks.location, blocks.attendees, blocks.redacted], ["Busy", "", "", "[]", true]);
	assert.equal(isBusyEvent({ ...base, transparent: true }), false);
	assert.equal(isBusyEvent({ ...base, responseStatus: "needs-action" }), false);
	assert.equal(isBusyEvent({ ...base, responseStatus: "declined" }), false);
	assert.equal(isBusyEvent({ ...base, responseStatus: "accepted" }), true);
});

test("calendarScopes: shared calendars filter by id (and the owner's null-calendar events for a default), in statements under D1's 100 parameters", async () => {
	const { orm, statements, calendar, grant, event } = setup();
	calendar("cal:work"); calendar("cal:u1", "u1", null); calendar("cal:other", "u3", "O");
	event("w1", "u1", "cal:work"); event("d1", "u1", null); event("d2", "u1", "cal:u1"); event("x1", "u3", "cal:other"); event("x2", "u3", null); event("p1", "u4", null);
	const granted = [{ id: "cal:work", ownerId: "u1" }, { id: "cal:u1", ownerId: "u1" }, { id: "cal:other", ownerId: "u3" }];
	const found = [];
	for (const scope of shares.calendarScopes(granted)) found.push(...(await orm.select({ id: calendarEvents.id }).from(calendarEvents).where(scope)).map((row) => row.id));
	assert.deepEqual(found.sort(), ["d1", "d2", "w1", "x1"], "x2 is u3's default calendar, which was not granted");
	// 200 grants: every statement stays under 100 bound parameters and together they cover every id.
	const many = Array.from({ length: 200 }, (_, index) => ({ id: `cal:n${index}`, ownerId: `o${index}` }));
	statements.length = 0;
	const scopes = shares.calendarScopes(many);
	for (const scope of scopes) await orm.select().from(calendarEvents).where(and(scope, eq(calendarEvents.title, "x")));
	assert.ok(scopes.length >= 3);
	for (const entry of statements) assert.ok(entry.params.length <= 90, `${entry.params.length} parameters`);
	const seen = new Set(statements.flatMap((entry) => entry.params));
	for (const entry of many) assert.ok(seen.has(entry.id), entry.id);
});

test("calendarScopes: no calendars means nothing matches", async () => {
	const { orm, event } = setup();
	event("d1");
	const scopes = shares.calendarScopes([]);
	assert.equal(scopes.length, 1);
	assert.equal((await orm.select().from(calendarEvents).where(scopes[0])).length, 0);
});

const email = (id) => `${id}@one.test`;

test("grantShare: the owner shares by email, a second grant for the same person is a 409, the owner and strangers to the instance are refused", async () => {
	const { sqlite, orm, calendar } = setup();
	calendar("cal:work");
	const ok = await shares.grantShare(orm, u("u1"), "cal:work", { email: " U2@One.test ", role: "read" });
	assert.equal(ok.ok, true);
	assert.deepEqual([ok.ownerId, ok.share.userId, ok.share.role, ok.share.email], ["u1", "u2", "read", email("u2")]);
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: email("u2"), role: "edit" })).status, 409);
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: email("u1"), role: "edit" })).status, 400);
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: "nobody@else.test", role: "read" })).status, 404);
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: email("u3"), role: "owner" })).status, 400);
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: email("u3"), role: undefined })).status, 400);
	sqlite.prepare("UPDATE users SET disabled = 1 WHERE id = 'u4'").run();
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: email("u4"), role: "read" })).status, 404, "a disabled account answers like an unknown address");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_shares").get().n, 1);
});

test("grantShare: a personal mailbox address finds its owner, a shared mailbox does not", async () => {
	const { sqlite, orm, calendar } = setup();
	calendar("cal:work");
	sqlite.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'corp.test', 'z', 1)").run();
	sqlite.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m1', 'u3', 'd1', 'sam', 'personal', 1), ('m2', 'u4', 'd1', 'team', 'shared', 1)").run();
	const ok = await shares.grantShare(orm, u("u1"), "cal:work", { email: "Sam@corp.test", role: "edit" });
	assert.equal(ok.ok, true);
	assert.equal(ok.share.userId, "u3");
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: "team@corp.test", role: "edit" })).status, 404);
});

test("grantShare: the default calendar gets its row on the first share; a manager cannot grant above manage, and a reader or editor cannot grant at all", async () => {
	const { sqlite, orm, calendar, grant } = setup();
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:u1", { email: email("u2"), role: "manage" })).ok, true);
	assert.equal(sqlite.prepare("SELECT user_id FROM dav_collections WHERE id = 'cal:u1'").get().user_id, "u1");
	assert.equal((await shares.grantShare(orm, u("u2"), "cal:u1", { email: email("u3"), role: "manage" })).ok, true, "a manager grants up to manage");
	calendar("cal:work"); grant("g5", "cal:work", "u3", "edit"); grant("g6", "cal:work", "u4", "read");
	assert.equal((await shares.grantShare(orm, u("u3"), "cal:work", { email: email("u2"), role: "read" })).status, 403);
	assert.equal((await shares.grantShare(orm, u("u4"), "cal:work", { email: email("u2"), role: "read" })).status, 403);
	assert.equal((await shares.grantShare(orm, { id: "u2" }, "cal:work", { email: email("u3"), role: "read" })).status, 404, "no role at all looks like no calendar");
	grant("g7", "cal:work", "u2", "freebusy");
	assert.equal((await shares.grantShare(orm, { id: "u2" }, "cal:work", { email: email("u1"), role: "read" })).status, 404, "free/busy does not even see the calendar");
});

test("grantShare: a manager cannot hand out more than their own role; the cap is 100 grants", async () => {
	const { sqlite, orm, calendar, grant } = setup();
	calendar("cal:work"); grant("g1", "cal:work", "u2", "manage");
	// Only an owner can grant "manage"+; a manager is capped at manage, which is also the top role, so test the role check through changeShare below.
	for (let index = 0; index < 98; index += 1) {
		sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, 'x', 'x', 'user', 1)").run(`bulk${index}`, `bulk${index}@one.test`);
		grant(`gb${index}`, "cal:work", `bulk${index}`, "read");
	}
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_shares").get().n, 99);
	assert.equal((await shares.grantShare(orm, u("u1"), "cal:work", { email: email("u3"), role: "read" })).ok, true);
	const over = await shares.grantShare(orm, u("u1"), "cal:work", { email: email("u4"), role: "read" });
	assert.equal(over.status, 409);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_shares").get().n, 100);
});

test("changeShare: a role change deletes the grant and inserts a new one with a new id, in one batch", async () => {
	const { sqlite, orm, statements, calendar, grant } = setup();
	calendar("cal:work"); grant("g1", "cal:work", "u2", "edit");
	let batched = 0;
	const original = orm.batch;
	orm.batch = async (list) => { batched += 1; return original(list); };
	const result = await shares.changeShare(orm, u("u1"), "cal:work", { id: "g1", role: "read" });
	assert.equal(result.ok, true);
	assert.equal(batched, 1);
	assert.equal(result.previousRole, "edit");
	assert.notEqual(result.share.id, "g1");
	assert.deepEqual(sqlite.prepare("SELECT id, role, grantee_user_id AS u FROM calendar_shares").all().map((row) => [row.role, row.u, row.id === "g1"]), [["read", "u2", false]]);
	assert.equal((await shares.changeShare(orm, u("u1"), "cal:work", { id: "g1", role: "read" })).status, 404, "the old id is gone");
	assert.equal((await shares.changeShare(orm, u("u1"), "cal:work", { id: result.share.id, role: "bogus" })).status, 400);
	// Same role: nothing to do, the id stays.
	const same = await shares.changeShare(orm, u("u1"), "cal:work", { id: result.share.id, role: "read" });
	assert.equal(same.ok, true);
	assert.equal(same.share.id, result.share.id);
	void statements;
});

test("changeShare and revokeShare: only on this calendar's grants, only by a manager or the owner", async () => {
	const { sqlite, orm, calendar, grant } = setup();
	calendar("cal:work"); calendar("cal:other", "u3", "O");
	grant("g1", "cal:work", "u2", "manage"); grant("g2", "cal:work", "u4", "read"); grant("g3", "cal:other", "u4", "read");
	assert.equal((await shares.revokeShare(orm, u("u2"), "cal:work", "g3")).status, 404, "a grant of another calendar cannot be reached through this one");
	assert.equal((await shares.changeShare(orm, u("u2"), "cal:work", { id: "g3", role: "edit" })).status, 404);
	assert.equal((await shares.revokeShare(orm, u("u4"), "cal:work", "g1")).status, 403);
	assert.equal((await shares.changeShare(orm, u("u4"), "cal:work", { id: "g2", role: "manage" })).status, 403);
	assert.equal((await shares.revokeShare(orm, u("u3"), "cal:work", "g2")).status, 404);
	const revoked = await shares.revokeShare(orm, u("u2"), "cal:work", "g2");
	assert.equal(revoked.ok, true);
	assert.equal(revoked.share.userId, "u4");
	assert.equal(await shares.getCalendarRole(orm, u("u4"), "cal:work"), null);
	assert.deepEqual(sqlite.prepare("SELECT id FROM calendar_shares ORDER BY id").all().map((row) => row.id), ["g1", "g3"]);
});

test("listShares: manager and owner only; entries carry the person and role", async () => {
	const { orm, calendar, grant } = setup();
	calendar("cal:work"); grant("g1", "cal:work", "u2", "manage"); grant("g2", "cal:work", "u3", "read");
	const own = await shares.listShares(orm, u("u1"), "cal:work");
	assert.deepEqual(own.shares.map((share) => [share.id, share.email, share.name, share.role]), [["g1", email("u2"), "User u2", "manage"], ["g2", email("u3"), "User u3", "read"]]);
	assert.equal((await shares.listShares(orm, u("u2"), "cal:work")).ok, true);
	assert.equal((await shares.listShares(orm, u("u3"), "cal:work")).status, 403);
	assert.equal((await shares.listShares(orm, u("u4"), "cal:work")).status, 404);
});

test("deleting a calendar's collection row or a grantee's account removes the grants", () => {
	const { sqlite, calendar, grant } = setup();
	calendar("cal:work"); calendar("cal:two"); grant("g1", "cal:work", "u2", "read"); grant("g2", "cal:two", "u2", "read"); grant("g3", "cal:two", "u3", "read");
	sqlite.prepare("DELETE FROM dav_collections WHERE id = 'cal:work'").run();
	sqlite.prepare("DELETE FROM users WHERE id = 'u3'").run();
	assert.deepEqual(sqlite.prepare("SELECT id FROM calendar_shares").all().map((row) => row.id), ["g2"]);
});

test("calendarScopes: the shared-calendar query is answered from the calendar and user indexes, never a table scan", async () => {
	const { sqlite, orm } = setup();
	const granted = [{ id: "cal:work", ownerId: "u1" }, { id: "cal:u1", ownerId: "u1" }];
	const [scope] = shares.calendarScopes(granted);
	const query = orm.select().from(calendarEvents).where(and(scope, lt(calendarEvents.startsAt, new Date(2000)), or(gte(calendarEvents.endsAt, new Date(1000)), ne(calendarEvents.repeat, "none")))).toSQL();
	const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params).map((row) => row.detail).join("\n");
	assert.match(plan, /calendar_events_calendar_starts_idx/);
	assert.match(plan, /calendar_events_user_starts_idx/);
	assert.doesNotMatch(plan, /SCAN calendar_events\b(?! USING)/);
});

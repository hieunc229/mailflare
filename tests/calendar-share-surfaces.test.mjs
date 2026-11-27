import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const db = "export function getDb(){return globalThis.calSurf.db}";
const fixtures = [
	await loadFixture({ name: "cal-surf-reminders", entryPoint: "src/lib/calendar/reminders.ts", mocks: { "@/db": db, "@/lib/push/server": "export async function sendPushContent(env,ids,content){globalThis.calSurf.pushed.push({ids,content})}" } }),
	await loadFixture({ name: "cal-surf-feed", entryPoint: "src/app/api/calendar/feed/route.ts", mocks: { "@/db": db, "@/lib/cloudflare": "export function getEnv(){return {}}", "@/lib/api/key-auth": "export async function authenticateApiKeyValue(){return {user:{id:globalThis.calSurf.keyUser},scopes:['calendar:read']}}" } }),
	await loadFixture({ name: "cal-surf-tools", entryPoint: "src/lib/calendar/tools.ts", mocks: { "@/db": db } }),
];
const [{ runCalendarReminders }, { GET: feed }, { runCalendarTool }] = await Promise.all(fixtures.map((fixture) => fixture.import()));
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calSurf; for (const fixture of fixtures) fixture.dispose(); });

function setup() {
	sqlite?.close();
	sqlite = installSqlite("calSurf", { schema, extra: { pushed: [], keyUser: "u2" } });
	// The reminder claim binds a raw Date, which node:sqlite refuses; real drivers convert it. Store it the way the timestamp column does.
	const prepare = sqlite.prepare.bind(sqlite);
	sqlite.prepare = (sql) => {
		const statement = prepare(sql);
		const fix = (args) => args.map((value) => (value instanceof Date ? Math.floor(value.getTime() / 1000) : value));
		const [run, all] = [statement.run.bind(statement), statement.all.bind(statement)];
		statement.run = (...args) => run(...fix(args));
		statement.all = (...args) => all(...fix(args));
		return statement;
	};
	for (const id of ["u1", "u2", "u3"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('g2', 'cal:work', 'u2', 'manage', 1), ('g3', 'cal:work', 'u3', 'read', 1)");
}
const soon = Math.floor(Date.now() / 1000) + 600;
const addEvent = (id) => sqlite.exec(`INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, reminder_minutes, created_at, updated_at) VALUES ('${id}', 'u1', 'cal:work', 'Board meeting', ${soon}, ${soon + 3600}, 30, 1, 1)`);

test("a reminder for an event in a shared calendar goes to its owner and to nobody it is shared with", async () => {
	setup();
	addEvent("e1");
	await runCalendarReminders({}, new Date());
	assert.equal(globalThis.calSurf.pushed.length, 1);
	assert.deepEqual(globalThis.calSurf.pushed[0].ids, ["u1"]);
});

test("the subscription feed holds the key owner's rows only: a grantee's key never lists the shared calendar's events", async () => {
	setup();
	addEvent("e1");
	sqlite.exec(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('mine', 'u2', 'My own', ${soon}, ${soon + 60}, 1, 1)`);
	globalThis.calSurf.keyUser = "u2";
	const text = await (await feed(new Request("https://m.test/api/calendar/feed?key=ep_x"))).text();
	assert.match(text, /My own/);
	assert.doesNotMatch(text, /Board meeting/);
	globalThis.calSurf.keyUser = "u1";
	assert.match(await (await feed(new Request("https://m.test/api/calendar/feed?key=ep_x"))).text(), /Board meeting/, "the owner's feed still has it");
});

test("MCP calendar tools see the caller's own events only, so a shared event cannot be read by id or by range", async () => {
	setup();
	addEvent("e1");
	const context = (id) => ({ env: {}, user: { id, calendarEnabled: true, timeZone: "UTC" }, confirmed: true });
	const range = { start: new Date((soon - 3600) * 1000).toISOString(), end: new Date((soon + 7200) * 1000).toISOString() };
	assert.equal((await runCalendarTool(context("u2"), "get_schedule", range)).events.length, 0);
	assert.equal((await runCalendarTool(context("u1"), "get_schedule", range)).events.length, 1);
	await assert.rejects(runCalendarTool(context("u2"), "get_event", { eventId: "e1" }));
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("reminders-query", 'export { reminderPage, runCalendarReminders, REMINDER_REPEATS } from "./src/lib/calendar/reminders.ts";');

const NOW = new Date("2026-06-10T12:00:00Z");
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const minutes = (n) => new Date(NOW.getTime() + n * 60_000).toISOString();
const days = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function event(id, repeat, startsAt, extra = "") {
	return `INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, repeat_anchor_day, reminder_minutes, response_status, created_at, updated_at${extra ? ", repeat_until" : ""}) VALUES ('${id}', 'u', '${id}', ${sec(startsAt)}, ${sec(startsAt) + 1800}, '${repeat}', ${repeat === "none" ? "NULL" : "NULL"}, 0, 'accepted', 1, 1${extra ? `, ${extra}` : ""});`;
}

const seed = `
	INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u', 'u@example.com', 'hash', 'U', 1);
	${event("one_due", "none", minutes(-2))}
	${event("one_old", "none", minutes(-10))}
	${event("one_far", "none", days(10))}
	${event("daily_live", "daily", days(-30))}
	${event("daily_ended", "daily", days(-30), sec(days(-1)))}
`;

const ids = (rows) => rows.map(({ event: row }) => row.id);

test("reminder queries are index backed", async (t) => {
	const { sqlite, db } = await newDatabase(t, seed);
	for (const repeat of ["none", "daily"]) {
		const { sql, params } = app.reminderPage(db, NOW, repeat, null).toSQL();
		const detail = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(" ");
		assert.match(detail, /calendar_events_repeat_starts_idx/, repeat);
	}
});

test("only reachable rows are read", async (t) => {
	const { db } = await newDatabase(t, seed);
	assert.deepEqual(ids(await app.reminderPage(db, NOW, "none", null)), ["one_due"]);
	assert.deepEqual(ids(await app.reminderPage(db, NOW, "daily", null)), ["daily_live"]);
});

test("a run reminds due events once", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	const marked = () => sqlite.prepare("SELECT id FROM calendar_events WHERE last_reminded_start IS NOT NULL ORDER BY id").all().map((row) => row.id);
	await app.runCalendarReminders(env, NOW);
	assert.deepEqual(marked(), ["daily_live", "one_due"]);
	const before = sqlite.prepare("SELECT id, last_reminded_start FROM calendar_events ORDER BY id").all();
	await app.runCalendarReminders(env, NOW);
	assert.deepEqual(sqlite.prepare("SELECT id, last_reminded_start FROM calendar_events ORDER BY id").all(), before);
});

test("keyset paging does not skip rows sharing a start", async (t) => {
	const start = minutes(-1);
	const { db } = await newDatabase(t, `${seed}${event("b1", "none", start)}${event("b2", "none", start)}${event("b3", "none", start)}${event("z_later", "none", minutes(30))}`);
	const all = ids(await app.reminderPage(db, NOW, "none", null));
	assert.deepEqual(all, ["one_due", "b1", "b2", "b3", "z_later"]);
	const rest = ids(await app.reminderPage(db, NOW, "none", { startsAt: new Date(start), id: "b1" }));
	assert.deepEqual(rest, ["b2", "b3", "z_later"]);
});

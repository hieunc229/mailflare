import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-tool-expansion-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// A two-table stand-in for drizzle: `select()` promises the event rows for calendarEvents and the override rows
// otherwise, which is all get_schedule reads.
const fakeDb = join(dir, "fake-db.mjs");
writeFileSync(fakeDb, `
import { calendarEvents } from "@/db/schema";
// Rows ride on globalThis because each bundle inlines its own copy of a module, and the test drives a second bundle.
export function getDb() {
	const select = () => {
		let table = null;
		const chain = {
			from(value) { table = value; return chain; },
			where() { return chain; },
			orderBy() { return chain; },
			limit() { return chain; },
			then(resolve, reject) { return Promise.resolve(table === calendarEvents ? globalThis.__calendarToolRows ?? [] : []).then(resolve, reject); },
		};
		return chain;
	};
	return { select };
}
`);

const shared = {
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22",
	alias: { "@": join(root, "src") }, logLevel: "silent",
};
await build({ ...shared, entryPoints: { t: join(root, "src/lib/calendar/tool-occurrences.ts"), r: join(root, "src/lib/calendar/reminder-utils.ts") } });
await build({
	...shared,
	entryPoints: { tools: join(root, "src/lib/calendar/tools.ts") },
	plugins: [{ name: "fake-db", setup: (bundle) => bundle.onResolve({ filter: /^@\/db$/ }, () => ({ path: fakeDb })) }],
});

const { expandToolEvents } = await import(pathToFileURL(join(dir, "t.mjs")).href);
const { dueReminderOccurrences } = await import(pathToFileURL(join(dir, "r.mjs")).href);
const { runCalendarTool } = await import(pathToFileURL(join(dir, "tools.mjs")).href);

const event = (over = {}) => ({
	id: "evt_1", userId: "usr_1", title: "Standup", description: "", location: "", attendees: "[]", color: "blue",
	repeat: "weekly", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null,
	excludedOccurrences: "[]", timeZone: null, reminderMinutes: 0, lastRemindedStart: null,
	// 2026-03-01 09:00 New York (EST), every Monday. US DST starts on 2026-03-08, so a New York expansion moves to 13:00Z.
	startsAt: new Date("2026-03-01T14:00:00Z"), endsAt: new Date("2026-03-01T14:30:00Z"),
	updatedAt: new Date("2026-02-20T00:00:00Z"), ...over,
});
const from = new Date("2026-03-01T00:00:00Z");
const to = new Date("2026-03-23T00:00:00Z");
const startTimes = (items) => items.map((item) => item.startsAt);

test("a NULL-zone series expands in UTC when the caller has no zone (unchanged context-free behavior)", () => {
	const occurrences = expandToolEvents([event()], from, to);
	assert.deepEqual(startTimes(occurrences), [
		"2026-03-01T14:00:00.000Z", "2026-03-08T14:00:00.000Z", "2026-03-15T14:00:00.000Z", "2026-03-22T14:00:00.000Z",
	]);
	assert.deepEqual([...new Set(occurrences.map((item) => item.timeZone))], ["UTC"]);
});

test("a NULL-zone series expands on the caller's default zone, keeping the authored wall clock across DST", () => {
	const occurrences = expandToolEvents([event()], from, to, 500, undefined, "America/New_York");
	// 09:00 in New York every week: 14:00Z while EST, 13:00Z once EDT starts.
	assert.deepEqual(startTimes(occurrences), [
		"2026-03-01T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-15T13:00:00.000Z", "2026-03-22T13:00:00.000Z",
	]);
	assert.deepEqual([...new Set(occurrences.map((item) => item.timeZone))], ["America/New_York"]);
});

test("an event's own zone wins over the caller default", () => {
	// 09:00 Berlin weekly: 08:00Z while CET, 07:00Z once CEST starts on 2026-03-29. Read in the caller's New York
	// zone instead, every occurrence would stay at 08:00Z, so the last two rows tell the two zones apart.
	const berlin = event({ timeZone: "Europe/Berlin", startsAt: new Date("2026-03-01T08:00:00Z"), endsAt: new Date("2026-03-01T08:30:00Z") });
	const occurrences = expandToolEvents([berlin], from, new Date("2026-04-06T00:00:00Z"), 500, undefined, "America/New_York");
	assert.deepEqual(startTimes(occurrences), [
		"2026-03-01T08:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-15T08:00:00.000Z", "2026-03-22T08:00:00.000Z",
		"2026-03-29T07:00:00.000Z", "2026-04-05T07:00:00.000Z",
	]);
	assert.deepEqual([...new Set(occurrences.map((item) => item.timeZone))], ["Europe/Berlin"]);
});

test("the reminder cron expands a NULL-zone series on the owner's zone", () => {
	// The 2026-03-08 occurrence starts at 13:00Z for a New York owner, so its at-time reminder is due just after 13:00Z.
	const due = dueReminderOccurrences(event(), new Date("2026-03-08T13:02:00Z"), 0, 3, undefined, "America/New_York");
	assert.deepEqual(due.map((item) => item.start.toISOString()), ["2026-03-08T13:00:00.000Z"]);
	// Without the owner's zone the same series is read in UTC (14:00Z), which is what the cron used to do.
	assert.equal(dueReminderOccurrences(event(), new Date("2026-03-08T13:02:00Z"), 0, 3).length, 0);
	assert.equal(dueReminderOccurrences(event(), new Date("2026-03-08T14:02:00Z"), 0, 3).length, 1);
});

test("get_schedule expands a NULL-zone series on the signed-in user's zone", async () => {
	globalThis.__calendarToolRows = [event()];
	test.after(() => { delete globalThis.__calendarToolRows; });
	const context = { env: {}, user: { id: "usr_1", calendarEnabled: true, timeZone: "America/New_York" } };
	const result = await runCalendarTool(context, "get_schedule", { start: "2026-03-01T00:00:00+00:00", end: "2026-03-23T00:00:00+00:00" });
	assert.deepEqual(startTimes(result.events), [
		"2026-03-01T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-15T13:00:00.000Z", "2026-03-22T13:00:00.000Z",
	]);
	assert.deepEqual([...new Set(result.events.map((item) => item.timeZone))], ["America/New_York"]);
});

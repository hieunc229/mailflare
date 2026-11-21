import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-calendar-reminders-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { utils: join(root, "src/lib/calendar/reminder-utils.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { normalizeReminderMinutes, formatReminderBody, REMINDER_MINUTE_OPTIONS, dueReminderOccurrences } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

test("reminder offsets accept whole minutes in range and nothing else", () => {
	for (const minutes of REMINDER_MINUTE_OPTIONS) assert.equal(normalizeReminderMinutes(minutes), minutes);
	for (const bad of [-1, 1.5, 10081, "15", null, undefined, NaN]) assert.equal(normalizeReminderMinutes(bad), null, String(bad));
});

test("reminder body shows the start in the event zone and the location when set", () => {
	const start = new Date("2026-11-02T14:30:00Z");
	assert.equal(formatReminderBody(start, "America/New_York", ""), "Mon, Nov 2, 9:30 AM");
	assert.equal(formatReminderBody(start, "America/New_York", " Room 4 "), "Mon, Nov 2, 9:30 AM · Room 4");
	assert.match(formatReminderBody(start, "Not/AZone", ""), /2026-11-02/);
});

const reminderEvent = { id: "evt_1", userId: "usr_1", title: "Sync", description: "", location: "", attendees: "[]", color: "#000", repeat: "none", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", timeZone: "UTC", reminderMinutes: 0, updatedAt: new Date("2026-11-01T00:00:00Z"), startsAt: new Date("2026-11-02T10:00:00Z"), endsAt: new Date("2026-11-02T10:30:00Z") };

test("an at-time-of-event reminder is due in the cron run just after the start, and only once past it", () => {
	const before = dueReminderOccurrences(reminderEvent, new Date("2026-11-02T09:57:00Z"), 0, 3);
	assert.equal(before.length, 0, "not due before the start");
	const run = dueReminderOccurrences(reminderEvent, new Date("2026-11-02T10:02:00Z"), 0, 3);
	assert.deepEqual(run.map((o) => o.start.toISOString()), ["2026-11-02T10:00:00.000Z"]);
	assert.equal(dueReminderOccurrences(reminderEvent, new Date("2026-11-02T10:02:00Z"), Date.parse("2026-11-02T10:00:00Z"), 3).length, 0, "already reminded");
	assert.equal(dueReminderOccurrences(reminderEvent, new Date("2026-11-02T10:06:00Z"), 0, 3).length, 0, "past the grace window");
});

test("a reminder with a lead still fires only before the start", () => {
	const event = { ...reminderEvent, reminderMinutes: 15 };
	assert.equal(dueReminderOccurrences(event, new Date("2026-11-02T09:50:00Z"), 0, 3).length, 1);
	assert.equal(dueReminderOccurrences(event, new Date("2026-11-02T10:01:00Z"), 0, 3).length, 0);
	assert.equal(dueReminderOccurrences(event, new Date("2026-11-02T09:40:00Z"), 0, 3).length, 0);
});

test("an at-time reminder does not fire for an event created or edited after its start", () => {
	const edited = { ...reminderEvent, updatedAt: new Date("2026-11-02T10:01:00Z") };
	assert.equal(dueReminderOccurrences(edited, new Date("2026-11-02T10:02:00Z"), 0, 3).length, 0);
	const early = { ...reminderEvent, updatedAt: new Date("2026-11-02T09:59:00Z") };
	assert.equal(dueReminderOccurrences(early, new Date("2026-11-02T10:02:00Z"), 0, 3).length, 1);
});

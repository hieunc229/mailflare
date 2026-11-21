import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-calendar-feed-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/calendar/feed.ts")], outfile: join(dir, "f.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { buildCalendarFeed, buildVevent, foldIcsLine } = await import(pathToFileURL(join(dir, "f.mjs")).href);

const base = { id: "evt_1", title: "Standup, daily", description: "", location: "", repeat: "none", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", timeZone: null, attendees: "[]", startsAt: new Date("2026-11-02T17:00:00Z"), endsAt: new Date("2026-11-02T17:30:00Z") };

test("one-off event is UTC with escaped text", () => {
	const ics = buildCalendarFeed([base], { name: "Mailflare", now: new Date("2026-11-01T00:00:00Z") });
	assert.match(ics, /DTSTART:20261102T170000Z\r\n/);
	assert.match(ics, /SUMMARY:Standup\\, daily\r\n/);
	assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});

test("weekday series uses BYDAY, zone and EXDATE", () => {
	const ics = buildCalendarFeed([{ ...base, repeat: "weekdays", repeatDays: "[1,3,5]", timeZone: "America/Los_Angeles", excludedOccurrences: `[${Date.parse("2026-11-04T17:00:00Z")}]` }], { name: "M" });
	assert.match(ics, /DTSTART;TZID=America\/Los_Angeles:20261102T090000\r\n/);
	assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\n/);
	assert.match(ics, /EXDATE;TZID=America\/Los_Angeles:20261104T090000\r\n/);
});

test("event text cannot start a new property line", () => {
	const hostile = "Lunch\rATTENDEE:mailto:evil@example.com\nX-ATTACK:1\r\nEND:VEVENT\u0000\u0007";
	const ics = buildCalendarFeed([{ ...base, title: hostile, description: hostile, location: hostile }], { name: "Mailflare" });
	const lines = ics.split("\r\n");
	for (const line of lines) assert.doesNotMatch(line, /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
	assert.equal(lines.filter((line) => line.startsWith("ATTENDEE")).length, 0);
	assert.equal(lines.filter((line) => line === "END:VEVENT").length, 1);
});

test("long lines fold at 75 octets", () => {
	const folded = foldIcsLine(`DESCRIPTION:${"é".repeat(100)}`);
	for (const line of folded.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75);
	assert.equal(folded.replace(/\r\n /g, ""), `DESCRIPTION:${"é".repeat(100)}`);
});

test("buildVevent is deterministic for a given stamp", () => {
	const lines = buildVevent({ ...base, updatedAt: new Date("2026-11-03T00:00:00Z") }, { stamp: "20261103T000000Z" });
	assert.deepEqual(lines, buildVevent({ ...base, updatedAt: new Date("2026-11-03T00:00:00Z") }, { stamp: "20261103T000000Z" }));
	assert.equal(lines[0], "BEGIN:VEVENT");
	assert.ok(lines.includes("DTSTAMP:20261103T000000Z"));
	assert.ok(lines.includes("LAST-MODIFIED:20261103T000000Z"));
});

test("an all-day event is written as DATE values in its zone", () => {
	const lines = buildVevent({ ...base, allDay: true, timeZone: "Europe/Berlin", startsAt: new Date("2026-11-04T23:00:00Z"), endsAt: new Date("2026-11-05T23:00:00Z") }, { stamp: "20261103T000000Z" });
	assert.ok(lines.includes("DTSTART;VALUE=DATE:20261105"), lines.join("|"));
	assert.ok(lines.includes("DTEND;VALUE=DATE:20261106"));
});

test("an override carries RECURRENCE-ID in the series zone", () => {
	const lines = buildVevent({ ...base, timeZone: "America/Los_Angeles" }, { stamp: "20261103T000000Z", recurrenceId: new Date("2026-11-09T17:00:00Z") });
	assert.ok(lines.includes("RECURRENCE-ID;TZID=America/Los_Angeles:20261109T090000"), lines.join("|"));
	assert.ok(lines.includes("DTSTART;TZID=America/Los_Angeles:20261102T090000"));
	assert.ok(!lines.some((line) => line.startsWith("RRULE")));
});

const allDay = { ...base, allDay: true, timeZone: "Europe/Berlin", startsAt: new Date("2026-11-04T23:00:00Z"), endsAt: new Date("2026-11-05T23:00:00Z") };

test("a legacy repeat that ends on an all-day event gets a DATE UNTIL (the last day, in the zone)", () => {
	// repeatUntil is the exclusive bound: midnight at the start of 10 November in Berlin.
	const lines = buildVevent({ ...allDay, repeat: "daily", repeatUntil: new Date("2026-11-09T23:00:00Z") }, { stamp: "20261103T000000Z" });
	assert.ok(lines.includes("RRULE:FREQ=DAILY;UNTIL=20261109"), lines.join("|"));
});

test("a timed repeat that ends keeps its UTC UNTIL", () => {
	const lines = buildVevent({ ...base, repeat: "daily", repeatUntil: new Date("2026-11-09T17:00:00Z") }, { stamp: "20261103T000000Z" });
	assert.ok(lines.includes("RRULE:FREQ=DAILY;UNTIL=20261109T170000Z"), lines.join("|"));
});

test("an all-day event without a zone of its own uses the fallback zone, not UTC", () => {
	const noZone = { ...allDay, timeZone: null };
	const withFallback = buildVevent(noZone, { stamp: "20261103T000000Z", fallbackZone: "Europe/Berlin" });
	assert.ok(withFallback.includes("DTSTART;VALUE=DATE:20261105"), withFallback.join("|"));
	assert.ok(withFallback.includes("DTEND;VALUE=DATE:20261106"));
	const none = buildVevent(noZone, { stamp: "20261103T000000Z" });
	assert.ok(none.includes("DTSTART;VALUE=DATE:20261104"), "no zone at all stays on UTC dates");
	// A timed event never takes the fallback.
	assert.ok(buildVevent(base, { stamp: "20261103T000000Z", fallbackZone: "Europe/Berlin" }).includes("DTSTART:20261102T170000Z"));
});

test("alarm writes the first reminder as a relative VALARM; the feed does not", () => {
	const event = { ...base, reminderMinutes: 15 };
	const lines = buildVevent(event, { stamp: "20261103T000000Z", alarm: true });
	const at = lines.indexOf("BEGIN:VALARM");
	assert.deepEqual(lines.slice(at, at + 5), ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Standup\\, daily", "TRIGGER:-PT15M", "END:VALARM"]);
	assert.equal(lines[at + 5], "END:VEVENT");
	assert.ok(buildVevent({ ...base, reminderMinutes: 0 }, { stamp: "s", alarm: true }).includes("TRIGGER:PT0S"));
	assert.ok(!buildVevent({ ...base, reminderMinutes: null }, { stamp: "s", alarm: true }).includes("BEGIN:VALARM"));
	assert.ok(!buildVevent(event, { stamp: "20261103T000000Z" }).includes("BEGIN:VALARM"));
	assert.ok(!buildCalendarFeed([event], { name: "M" }).includes("VALARM"));
});

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
const { buildCalendarFeed, foldIcsLine } = await import(pathToFileURL(join(dir, "f.mjs")).href);

const base = { id: "evt_1", title: "Standup, daily", description: "", location: "", repeat: "none", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", timeZone: null, attendees: "[]", startsAt: new Date("2026-11-02T17:00:00Z"), endsAt: new Date("2026-11-02T17:30:00Z") };

test("one-off event is UTC with escaped text", () => {
	const ics = buildCalendarFeed([base], { name: "Mailflare", now: new Date("2026-11-01T00:00:00Z") });
	assert.match(ics, /DTSTART:20261102T170000Z\r\n/);
	assert.match(ics, /SUMMARY:Standup\\, daily\r\n/);
	assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});

test("weekday series uses BYDAY, zone and EXDATE", () => {
	const ics = buildCalendarFeed([{ ...base, repeat: "weekdays", repeatDays: "[1,3,5]", timeZone: "America/Vancouver", excludedOccurrences: `[${Date.parse("2026-11-04T17:00:00Z")}]` }], { name: "M" });
	assert.match(ics, /DTSTART;TZID=America\/Vancouver:20261102T090000\r\n/);
	assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\n/);
	assert.match(ics, /EXDATE;TZID=America\/Vancouver:20261104T090000\r\n/);
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

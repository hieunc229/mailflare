import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-calendar-expansion-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// One bundle for both modules so the viewer zone and its cache are one shared module.
const entry = join(outDir, "entry.ts");
writeFileSync(entry, 'export * from "@/app/(calendar)/calendar/utils";\nexport { clearUserTimeZoneCache } from "@/lib/time/utils";\n');

await build({
	entryPoints: { calendar: entry },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { calendarAnchorDay, calendarTimeZone, clearUserTimeZoneCache, expandCalendarEvents, nextCalendarOccurrence, rescheduleCalendarOccurrence } = await import(pathToFileURL(join(outDir, "calendar.mjs")).href);

// getUserTimeZone() returns "UTC" on the server, so the viewer has to look like a browser.
let savedZone = "Europe/Berlin";
globalThis.window = { localStorage: { getItem: () => JSON.stringify({ timeZone: savedZone }) } };
function viewerZone(zone) {
	savedZone = zone;
	clearUserTimeZoneCache();
}

/** The wall clock a zone shows for an instant, as HH:MM. */
function wallClock(value, timeZone) {
	return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

const weekly = {
	id: "evt_weekly",
	title: "Standup",
	description: "",
	location: "",
	attendees: "[]",
	color: "#2563eb",
	repeat: "weekly",
	repeatDays: "[]",
	repeatAnchorDay: null,
	repeatUntil: null,
	excludedOccurrences: "[]",
	// Monday 2026-02-23 09:00 America/New_York (EST), one hour long.
	startsAt: "2026-02-23T14:00:00.000Z",
	endsAt: "2026-02-23T15:00:00.000Z",
	timeZone: "America/New_York",
};

const rangeStart = new Date("2026-02-20T00:00:00.000Z");
const rangeEnd = new Date("2026-03-20T00:00:00.000Z");

test("a series authored in America/New_York keeps its 09:00 wall time across the 2026-03-08 DST change", () => {
	for (const zone of ["Europe/Berlin", "Asia/Tokyo", "UTC"]) {
		viewerZone(zone);
		assert.equal(calendarTimeZone(weekly), "America/New_York", `authored zone wins for a ${zone} viewer`);
		const starts = expandCalendarEvents([weekly], rangeStart, rangeEnd).map((occurrence) => occurrence.startsAt);
		// 09:00 EST before the change, 09:00 EDT after it: the wall time holds, the instant moves an hour.
		assert.deepEqual(starts, [
			"2026-02-23T14:00:00.000Z",
			"2026-03-02T14:00:00.000Z",
			"2026-03-09T13:00:00.000Z",
			"2026-03-16T13:00:00.000Z",
		], `occurrences for a ${zone} viewer`);
		// A weekly series written in UTC would sit at 14:00Z throughout; the authored zone is what holds 09:00.
		for (const start of starts) assert.equal(wallClock(start, "America/New_York"), "09:00", `${start} is 09:00 in New York for a ${zone} viewer`);
	}
});

test("next occurrence is computed in the authored zone, not the viewer's", () => {
	for (const zone of ["Europe/Berlin", "Asia/Tokyo", "UTC"]) {
		viewerZone(zone);
		assert.equal(nextCalendarOccurrence(weekly, new Date("2026-03-05T00:00:00.000Z"))?.toISOString(), "2026-03-09T13:00:00.000Z", `next after 2026-03-05 for a ${zone} viewer`);
		assert.equal(nextCalendarOccurrence({ ...weekly, repeat: "weekdays", repeatDays: "[1,2,3,4,5]" }, new Date("2026-03-07T00:00:00.000Z"))?.toISOString(), "2026-03-09T13:00:00.000Z", `listed-days repeat keeps 09:00 New York for a ${zone} viewer`);
	}
});

test("the monthly anchor day comes from the authored zone", () => {
	viewerZone("Asia/Tokyo");
	// 2026-03-09T01:00Z is still Sunday the 8th, 21:00, in New York but Monday the 9th in Tokyo.
	assert.equal(calendarAnchorDay(weekly, new Date("2026-03-09T01:00:00.000Z")), 8);
});

test("rescheduling a series shifts it in the authored zone", () => {
	viewerZone("Asia/Tokyo");
	const next = rescheduleCalendarOccurrence(weekly, new Date(weekly.startsAt), new Date(weekly.endsAt), new Date("2026-03-05T00:00:00.000Z"));
	assert.deepEqual(next && { startsAt: next.startsAt.toISOString(), endsAt: next.endsAt.toISOString() }, { startsAt: "2026-03-09T13:00:00.000Z", endsAt: "2026-03-09T14:00:00.000Z" });
});

test("a series with no authored zone still expands in the viewer's zone", () => {
	viewerZone("Europe/Berlin");
	// Rows that predate zone capture hold null and keep the old viewer-zone expansion: 15:00 Berlin every Monday.
	const nullZone = { ...weekly, timeZone: null, id: "evt_null", startsAt: "2026-03-23T14:00:00.000Z", endsAt: "2026-03-23T15:00:00.000Z" };
	assert.deepEqual(expandCalendarEvents([nullZone], new Date("2026-03-20T00:00:00.000Z"), new Date("2026-04-10T00:00:00.000Z")).map((occurrence) => occurrence.startsAt), [
		"2026-03-23T14:00:00.000Z",
		"2026-03-30T13:00:00.000Z",
		"2026-04-06T13:00:00.000Z",
	]);
});

test("an unreadable authored zone falls back to UTC instead of breaking expansion", () => {
	viewerZone("Asia/Tokyo");
	assert.equal(calendarTimeZone({ ...weekly, timeZone: "Not/AZone" }), "UTC");
	assert.equal(calendarTimeZone(undefined), "Asia/Tokyo");
	assert.equal(calendarTimeZone(null), "Asia/Tokyo");
});

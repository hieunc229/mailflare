import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

// The VTIMEZONE generator runs in a child process with a timeout: a scanner that failed to advance
// (rounded transition instants kept the old offset) hung forever on sub-minute historical offsets.
const require = createRequire(new URL("../package.json", import.meta.url));
const { build } = require("esbuild");
const bundled = await build({
	entryPoints: ["src/lib/calendar/vtimezone.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`;
const feedBundled = await build({
	entryPoints: ["src/lib/calendar/feed.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
});
const feedModuleUrl = `data:text/javascript;base64,${Buffer.from(feedBundled.outputFiles[0].text).toString("base64")}`;

test("historical sub-minute offsets export their VTIMEZONE without hanging", { timeout: 30_000 }, () => {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e",
		`import { vtimezoneLines } from ${JSON.stringify(moduleUrl)}; console.log(vtimezoneLines("Asia/Colombo", [{ startMs: Date.parse("1905-12-25T00:00:00Z"), endMs: Date.parse("1906-01-10T00:00:00Z"), open: false }]).join("\\n"));`],
		{ timeout: 20_000, encoding: "utf8" });
	assert.equal(child.error, undefined, child.error?.message);
	assert.equal(child.status, 0, child.stderr);
	const lines = child.stdout.trim().split("\n");
	assert.ok(lines.includes("BEGIN:VTIMEZONE"), child.stdout);
	// Colombo moved from +05:19:32 to +05:30 on 1905-12-31; offsets carry seconds, not a rounded minute.
	assert.ok(lines.includes("TZOFFSETFROM:+051932"), child.stdout);
	assert.ok(lines.includes("TZOFFSETTO:+0530"), child.stdout);
});

const { vtimezoneLines } = await import(moduleUrl);

test("a zone that abolished DST gets explicit observances, not an invented rule", () => {
	// Mexico ended DST after 2022-10-30: an RRULE tail inferred from the last streak would keep
	// predicting an April transition into -0500 forever, mis-timing every post-abolition instant.
	const lines = vtimezoneLines("America/Mexico_City", [{ startMs: Date.parse("2018-01-01T00:00:00Z"), endMs: Date.parse("2041-01-01T00:00:00Z"), open: false }]);
	assert.equal(lines.some((line) => line.startsWith("RRULE")), false, lines.join("\n"));
	assert.equal(lines.findLast((line) => line.startsWith("TZOFFSETTO")), "TZOFFSETTO:-0600", lines.join("\n")); // Permanent standard time wins past the last observance.
});

test("a stable zone still collapses to a yearly rule, UNTIL-bounded in UTC on a closed window", () => {
	const lines = vtimezoneLines("America/Los_Angeles", [{ startMs: Date.parse("2026-01-01T00:00:00Z"), endMs: Date.parse("2030-03-10T10:00:00Z"), open: false }]);
	// A bounded window caps its inferred tail at the verified edge, in the UTC form RFC 5545 3.3.10
	// requires — a local-time UNTIL would be a spec violation some parsers reject.
	assert.ok(lines.includes("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;UNTIL=20300310T100000Z"), lines.join("\n"));
	assert.ok(lines.includes("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;UNTIL=20300310T100000Z"), lines.join("\n"));
});

test("an open window keeps its rule tail unbounded so a gap occurrence still follows DST", () => {
	// An open-ended series' coverage horizon is artificial; an UNTIL there would freeze its later
	// occurrences at the last observed offset (July 2045 LA imported 17:00Z instead of 16:00Z).
	const lines = vtimezoneLines("America/Los_Angeles", [{ startMs: Date.parse("2026-01-01T00:00:00Z"), endMs: Date.parse("2041-01-01T00:00:00Z"), open: true }]);
	const rules = lines.filter((line) => line.startsWith("RRULE:"));
	assert.equal(rules.length, 2, lines.join("\n"));
	assert.equal(rules.every((line) => !line.includes("UNTIL")), true, lines.join("\n"));
});

test("a fixed Etc zone emits its real offset, not UTC", () => {
	// Etc/GMT+N is IANA's UTC-N (the sign is inverted by convention); the fixed-zone fast path used
	// to emit +0000 for all of them, silently shifting every instant it anchored.
	const lines = vtimezoneLines("Etc/GMT+5", [{ startMs: Date.parse("2026-01-01T00:00:00Z"), endMs: Date.parse("2027-01-01T00:00:00Z"), open: false }]);
	assert.ok(lines.includes("TZOFFSETFROM:-0500"), lines.join("\n"));
	assert.ok(lines.includes("TZOFFSETTO:-0500"), lines.join("\n"));
	assert.equal(lines.some((line) => line.includes("+0000")), false, lines.join("\n"));
});

test("offset excursions reverting inside a probe gap still enter observations", () => {
	// Gaza 2040 resumes DST for a week after Ramadan (+03:00 Oct 20 00:00Z -> Oct 26 23:00Z) and
	// Recife's 2000 summer time ran one week (-02:00 Oct 8 03:00Z -> Oct 15 02:00Z). These starts
	// match the route's startsAt-400d window edge, so the old 7-day grid probed Oct 19 + Oct 26
	// (Gaza) and Oct 8 + Oct 15 (Recife) at the same offset on both ends and emitted nothing.
	const gaza = vtimezoneLines("Asia/Gaza", [{ startMs: Date.parse("2039-09-16T23:30:00Z"), endMs: Date.parse("2041-01-01T00:00:00Z"), open: false }]);
	assert.ok(gaza.includes("DTSTART:20401020T020000"), gaza.join("\n")); // +02 -> +03 in the FROM frame.
	assert.ok(gaza.includes("TZOFFSETTO:+0300"), gaza.join("\n"));
	const recife = vtimezoneLines("America/Recife", [{ startMs: Date.parse("1999-09-05T02:30:00Z"), endMs: Date.parse("2000-11-01T00:00:00Z"), open: false }]);
	assert.ok(recife.includes("DTSTART:20001008T000000"), recife.join("\n")); // -03 -> -02 in the FROM frame.
	assert.ok(recife.includes("DTSTART:20001015T000000"), recife.join("\n")); // -02 -> -03.
});

test("an over-budget fixture refuses the download but leaves feed bytes untouched", async () => {
	const { buildCalendarFeed, ExportLimitError } = await import(feedModuleUrl);
	const base = { title: "S", description: "", location: "", repeat: "weekly", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: new Date("2058-01-01T00:00:00Z"), repeatInterval: null, repeatWeekday: null, repeatWeek: null, excludedOccurrences: "[]", attendees: "[]", responseStatus: null };
	const event = (zone, id) => ({ ...base, id, timeZone: zone, startsAt: new Date("2026-01-05T17:00:00Z"), endsAt: new Date("2026-01-05T18:00:00Z") });
	// Five ~34-year coverage windows exceed the 50k probe budget in aggregate: the download must
	// refuse explicitly rather than starve whichever TZID sorts last, and it must not degrade one.
	const crowded = [event("America/Chicago", "chi"), event("America/Denver", "den"), event("America/Detroit", "det"), event("America/Halifax", "hal"), event("America/Los_Angeles", "lax")];
	assert.throws(() => buildCalendarFeed(crowded, { name: "T", download: true }), ExportLimitError);
	// The budget and window machinery are download-only: the feed emits the same TZID forms it
	// always did, on the same fixture, without scanning or failing.
	const feed = buildCalendarFeed(crowded, { name: "T", download: false });
	for (const { timeZone } of crowded) assert.match(feed, new RegExp(`DTSTART;TZID=${timeZone.replace("/", "\\/")}:20260105T`));
	assert.doesNotMatch(feed, /VTIMEZONE/);
});

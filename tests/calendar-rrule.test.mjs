import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-rrule-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: { rrule: join(root, "src/lib/calendar/rrule.ts"), tools: join(root, "src/lib/calendar/tool-occurrences.ts") }, outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", alias: { "@": join(root, "src") }, logLevel: "silent" });
const { parseRrule, expandRrule, expandEventOccurrences, expandEventStarts, legacyRepeatFor, legacyRrule, limitRrule, rruleEndedBefore } = await import(pathToFileURL(join(dir, "rrule.mjs")).href);
const { expandToolEvents } = await import(pathToFileURL(join(dir, "tools.mjs")).href);

const FAR = new Date("2100-01-01T00:00:00Z");
const run = (rule, start, zone = "UTC", max = 500, from = new Date(start)) => expandRrule(parseRrule(rule, zone), new Date(start), zone, from, FAR, max).map((d) => d.toISOString());

test("daily with an interval and COUNT", () => {
	assert.deepEqual(run("FREQ=DAILY;INTERVAL=2;COUNT=3", "2026-01-01T09:00:00Z"), ["2026-01-01T09:00:00.000Z", "2026-01-03T09:00:00.000Z", "2026-01-05T09:00:00.000Z"]);
});

test("weekly BYDAY keeps DTSTART as the first instance and counts it", () => {
	assert.deepEqual(run("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "2026-01-07T09:00:00Z"), ["2026-01-07", "2026-01-12", "2026-01-14", "2026-01-19"].map((d) => `${d}T09:00:00.000Z`));
});

test("WKST changes which weeks an interval skips (RFC 5545 example)", () => {
	const days = (wkst) => run(`FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${wkst}`, "1997-08-05T09:00:00Z").map((d) => d.slice(8, 10));
	assert.deepEqual(days("MO"), ["05", "10", "19", "24"]);
	assert.deepEqual(days("SU"), ["05", "17", "19", "31"]);
});

test("monthly nth weekday, last weekday by BYSETPOS and last day by BYMONTHDAY -1", () => {
	assert.deepEqual(run("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", "2026-01-13T09:00:00Z").map((d) => d.slice(0, 10)), ["2026-01-13", "2026-02-10", "2026-03-10"]);
	assert.deepEqual(run("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "2026-01-30T09:00:00Z").map((d) => d.slice(0, 10)), ["2026-01-30", "2026-02-27", "2026-03-31"]);
	assert.deepEqual(run("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4", "2026-01-31T09:00:00Z").map((d) => d.slice(0, 10)), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("yearly: Feb 29 only in leap years, last Sunday of March", () => {
	assert.deepEqual(run("FREQ=YEARLY;COUNT=3", "2024-02-29T09:00:00Z").map((d) => d.slice(0, 10)), ["2024-02-29", "2028-02-29", "2032-02-29"]);
	assert.deepEqual(run("FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;COUNT=2", "2026-03-29T09:00:00Z").map((d) => d.slice(0, 10)), ["2026-03-29", "2027-03-28"]);
});

test("UNTIL is inclusive as a date-time and as a whole day", () => {
	assert.equal(run("FREQ=DAILY;UNTIL=20260103T090000Z", "2026-01-01T09:00:00Z").length, 3);
	assert.equal(run("FREQ=DAILY;UNTIL=20260103T085959Z", "2026-01-01T09:00:00Z").length, 2);
	assert.equal(run("FREQ=DAILY;UNTIL=20260103", "2026-01-01T09:00:00Z").length, 3);
});

test("wall-clock time survives DST in Los Angeles and Berlin", () => {
	assert.deepEqual(run("FREQ=DAILY;COUNT=3", "2026-03-07T17:00:00Z", "America/Los_Angeles"), ["2026-03-07T17:00:00.000Z", "2026-03-08T16:00:00.000Z", "2026-03-09T16:00:00.000Z"]);
	assert.deepEqual(run("FREQ=DAILY;COUNT=3", "2026-10-31T16:00:00Z", "America/Los_Angeles"), ["2026-10-31T16:00:00.000Z", "2026-11-01T17:00:00.000Z", "2026-11-02T17:00:00.000Z"]);
	assert.deepEqual(run("FREQ=WEEKLY;COUNT=2", "2026-03-25T09:00:00Z", "Europe/Berlin"), ["2026-03-25T09:00:00.000Z", "2026-04-01T08:00:00.000Z"]);
});

test("a window far after DTSTART gives the same instants as stepping from the start", () => {
	const rule = parseRrule("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15", "UTC");
	const start = new Date("2015-02-15T10:00:00Z");
	const all = expandRrule(rule, start, "UTC", start, FAR, 100000).filter((d) => d >= new Date("2026-01-01") && d < new Date("2027-01-01")).slice(0, 500);
	assert.deepEqual(expandRrule(rule, start, "UTC", new Date("2026-01-01"), new Date("2027-01-01"), 500), all);
	assert.equal(all.length, 4);
});

test("unsupported or malformed rules parse to null", () => {
	for (const bad of ["FREQ=HOURLY", "FREQ=MINUTELY", "FREQ=DAILY;BYHOUR=9", "FREQ=DAILY;BYYEARDAY=3", "FREQ=YEARLY;BYWEEKNO=2", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=1000", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;COUNT=5001", "FREQ=DAILY;COUNT=1;COUNT=2", "BYDAY=MO", "FREQ=WEEKLY;BYDAY=2MO", "FREQ=WEEKLY;BYMONTHDAY=3", "FREQ=DAILY;BYSETPOS=1", "FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=MONTHLY;BYMONTH=13", "FREQ=DAILY;UNTIL=soon", "FREQ=DAILY;X-FOO=1", "", `FREQ=DAILY;${"X".repeat(2000)}`]) assert.equal(parseRrule(bad), null, bad);
	assert.ok(parseRrule("RRULE:freq=daily;interval=2"));
});

const event = (extra) => ({ startsAt: new Date("2026-01-05T09:00:00Z"), endsAt: new Date("2026-01-05T10:00:00Z"), timeZone: "UTC", repeat: "custom", rrule: "FREQ=WEEKLY;INTERVAL=2", excludedOccurrences: "[]", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, ...extra });

test("expandEventOccurrences applies exclusions and counts overlap, not just start", () => {
	const skipped = Date.parse("2026-01-19T09:00:00Z");
	const got = expandEventOccurrences(event({ excludedOccurrences: JSON.stringify([skipped]) }), new Date("2026-01-01"), new Date("2026-02-10"), 10).map((d) => d.toISOString());
	assert.deepEqual(got, ["2026-01-05T09:00:00.000Z", "2026-02-02T09:00:00.000Z"]);
	assert.equal(expandEventOccurrences(event(), new Date("2026-01-05T09:30:00Z"), new Date("2026-01-05T09:45:00Z")).length, 1);
	assert.equal(expandEventOccurrences(event(), new Date("2026-01-05T10:00:00Z"), new Date("2026-01-06")).length, 0);
});

test("a custom row without a usable rule is one occurrence, never an endless series", () => {
	for (const rrule of [null, "FREQ=HOURLY", "garbage"]) assert.equal(expandEventStarts(event({ rrule }), new Date("2026-01-01"), FAR).length, 1);
});

const T0 = new Date("2026-01-01T09:00:00Z");
const CUT = new Date("2026-06-01T00:00:00Z");

test("limitRrule moves the end only when the series reaches the cut, and drops COUNT only then", () => {
	assert.equal(limitRrule("FREQ=DAILY;COUNT=500", CUT, T0, "UTC", false), "FREQ=DAILY;UNTIL=20260531T235959Z");
	assert.equal(limitRrule("RRULE:FREQ=DAILY;UNTIL=20300101", CUT, T0, "UTC", false), "FREQ=DAILY;UNTIL=20260531T235959Z");
	assert.equal(limitRrule("FREQ=WEEKLY;BYDAY=TH", CUT, T0, "UTC", false), "FREQ=WEEKLY;BYDAY=TH;UNTIL=20260531T235959Z");
	// The cut is exclusive: an occurrence exactly at the cut goes.
	assert.equal(limitRrule("FREQ=DAILY", new Date("2026-01-03T09:00:00Z"), T0, "UTC", false), "FREQ=DAILY;UNTIL=20260103T085959Z");
});

test("limitRrule never lengthens a series that already ended before the cut", () => {
	assert.equal(limitRrule("FREQ=DAILY;COUNT=5", CUT, T0, "UTC", false), "FREQ=DAILY;COUNT=5", "an ended COUNT series stays 5");
	assert.equal(limitRrule("RRULE:FREQ=DAILY;UNTIL=20260110T090000Z", CUT, T0, "UTC", false), "RRULE:FREQ=DAILY;UNTIL=20260110T090000Z", "a past UNTIL stays");
	assert.equal(limitRrule("FREQ=DAILY;UNTIL=20260110", CUT, T0, "UTC", false), "FREQ=DAILY;UNTIL=20260110", "a past date UNTIL stays");
	// The last occurrence is on the cut's last second: kept, so there is nothing to change either.
	assert.equal(limitRrule("FREQ=DAILY;COUNT=3", new Date("2026-01-03T09:00:01Z"), T0, "UTC", false), "FREQ=DAILY;COUNT=3");
});

test("limitRrule writes a DATE UNTIL for an all-day event and a date-time for a timed one", () => {
	const midnight = new Date("2026-01-01T23:00:00Z"); // 2026-01-02 00:00 in Berlin
	assert.equal(limitRrule("FREQ=DAILY;COUNT=500", new Date("2026-06-01T22:00:00Z"), midnight, "Europe/Berlin", true), "FREQ=DAILY;UNTIL=20260601", "the cut at local midnight keeps the day before");
	assert.equal(limitRrule("FREQ=DAILY;COUNT=500", new Date("2026-06-01T10:00:00Z"), midnight, "Europe/Berlin", true), "FREQ=DAILY;UNTIL=20260601", "a cut during the day keeps that day's occurrence");
	assert.equal(limitRrule("FREQ=DAILY;UNTIL=20300101", new Date("2026-06-01T22:00:00Z"), midnight, "Europe/Berlin", true), "FREQ=DAILY;UNTIL=20260601");
	assert.equal(limitRrule("FREQ=DAILY;COUNT=3", new Date("2026-06-01T22:00:00Z"), midnight, "Europe/Berlin", true), "FREQ=DAILY;COUNT=3");
	assert.equal(limitRrule("FREQ=DAILY;UNTIL=20300101", new Date("2026-06-01T22:00:00Z"), midnight, "Europe/Berlin", false), "FREQ=DAILY;UNTIL=20260601T215959Z");
});

test("rruleEndedBefore tells whether any occurrence remains", () => {
	assert.equal(rruleEndedBefore("FREQ=DAILY;COUNT=5", T0, "UTC", CUT), true);
	assert.equal(rruleEndedBefore("FREQ=DAILY;COUNT=5", T0, "UTC", new Date("2026-01-05T09:00:00Z")), false, "the last occurrence still remains at that instant");
	assert.equal(rruleEndedBefore("FREQ=DAILY;UNTIL=20260110", T0, "UTC", CUT), true);
	assert.equal(rruleEndedBefore("FREQ=DAILY", T0, "UTC", CUT), false);
	assert.equal(rruleEndedBefore("FREQ=DAILY;UNTIL=20300101", T0, "UTC", CUT), false);
	assert.equal(rruleEndedBefore("garbage", T0, "UTC", CUT), true, "an unreadable rule is the one occurrence on DTSTART");
});

test("impossible rules parse to null, so the caller shows one occurrence", () => {
	for (const bad of ["FREQ=MONTHLY;BYDAY=6MO", "FREQ=MONTHLY;BYDAY=-6FR", "FREQ=YEARLY;BYMONTH=3;BYDAY=6SU", "FREQ=YEARLY;BYMONTHDAY=5;BYDAY=6SU",
		"FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31", "FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31", "FREQ=YEARLY;BYMONTH=4,6,9,11;BYMONTHDAY=-31", "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
		"FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA;BYSETPOS=366", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=26", "FREQ=MONTHLY;BYMONTHDAY=1,15;BYSETPOS=3", "FREQ=YEARLY;BYSETPOS=2", "FREQ=YEARLY;BYMONTH=3;BYDAY=SU;BYSETPOS=-6"]) assert.equal(parseRrule(bad), null, bad);
	for (const good of ["FREQ=YEARLY;BYDAY=53MO", "FREQ=YEARLY;BYDAY=-1SU", "FREQ=MONTHLY;BYDAY=5MO", "FREQ=MONTHLY;BYDAY=-5FR", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "FREQ=YEARLY;BYMONTH=2,4;BYMONTHDAY=30",
		"FREQ=MONTHLY;BYMONTHDAY=31", "FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA;BYSETPOS=313", "FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYSETPOS=-366", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "FREQ=YEARLY;BYMONTH=1,2,3;BYDAY=MO;BYSETPOS=15"]) assert.ok(parseRrule(good), good);
	assert.equal(expandEventStarts(event({ rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30" }), new Date("2026-01-01"), FAR).length, 1);
});

test("a long COUNT series costs the same per window as a short one: days before the window are not converted", () => {
	const rule = parseRrule("FREQ=DAILY;COUNT=5000", "America/Los_Angeles");
	const start = new Date("2016-01-04T17:00:00Z");
	const from = new Date("2026-03-10T00:00:00Z");
	const begin = performance.now();
	let found = 0;
	for (let slot = 0; slot < 400; slot++) found += expandRrule(rule, start, "America/Los_Angeles", new Date(from.getTime() + slot * 900_000), new Date(from.getTime() + slot * 900_000 + 3_600_000), 1).length;
	const elapsed = performance.now() - begin;
	assert.ok(found > 0);
	assert.ok(elapsed < 1500, `400 windows took ${elapsed.toFixed(0)} ms`);
	assert.equal(expandRrule(rule, start, "America/Los_Angeles", new Date("2016-01-04T00:00:00Z"), FAR, 6000).length, 5000, "and COUNT is still honoured in full");
});

test("the work budget returns partial results for a rule that is rarely true, and COUNT with sparse matches is honoured up to it", () => {
	const sparse = expandRrule(parseRrule("FREQ=DAILY;BYMONTHDAY=31;COUNT=300", "UTC"), new Date("2026-01-31T09:00:00Z"), "UTC", new Date("2026-01-01"), new Date("2200-01-01"), 1000);
	assert.equal(sparse.length, 300);
	const expected = [];
	for (let month = 0; expected.length < 300; month++) { const day = new Date(Date.UTC(2026, month, 31, 9)); if (day.getUTCDate() === 31) expected.push(day.toISOString()); }
	assert.deepEqual(sparse.map((d) => d.toISOString()), expected);
	const begin = performance.now();
	const partial = expandRrule(parseRrule("FREQ=DAILY;BYMONTH=2;COUNT=5000", "UTC"), new Date("2026-02-01T09:00:00Z"), "UTC", new Date("2026-01-01"), new Date("2400-01-01"), 6000);
	assert.ok(partial.length > 500 && partial.length < 5000, `${partial.length} found`);
	assert.ok(performance.now() - begin < 1500);
	const yearly = expandRrule(parseRrule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=5", "UTC"), new Date("2024-02-29T09:00:00Z"), "UTC", new Date("2024-01-01"), new Date("2400-01-01"), 10);
	assert.deepEqual(yearly.map((d) => d.getUTCFullYear()), [2024, 2028, 2032, 2036, 2040]);
});

test("legacyRepeatFor maps what the legacy columns express and refuses the rest", () => {
	const mon = new Date("2026-01-05T09:00:00Z");
	assert.deepEqual(legacyRepeatFor("FREQ=WEEKLY", mon, "UTC"), { repeat: "weekly", repeatDays: [], repeatAnchorDay: null, repeatUntil: null });
	assert.equal(legacyRepeatFor("FREQ=WEEKLY;BYDAY=MO", mon, "UTC").repeat, "weekly");
	assert.deepEqual(legacyRepeatFor("FREQ=WEEKLY;BYDAY=MO,WE", mon, "UTC").repeatDays, [1, 3]);
	assert.equal(legacyRepeatFor("FREQ=WEEKLY;BYDAY=TU,WE", mon, "UTC"), null);
	assert.equal(legacyRepeatFor("FREQ=DAILY", mon, "UTC").repeat, "daily");
	assert.equal(legacyRepeatFor("FREQ=MONTHLY;BYMONTHDAY=5", mon, "UTC").repeatAnchorDay, 5);
	assert.equal(legacyRepeatFor("FREQ=MONTHLY;BYMONTHDAY=6", mon, "UTC"), null);
	assert.equal(legacyRepeatFor("FREQ=MONTHLY", new Date("2026-01-31T09:00:00Z"), "UTC"), null, "RFC skips short months, the legacy repeat clamps");
	for (const rule of ["FREQ=WEEKLY;INTERVAL=2", "FREQ=MONTHLY;BYDAY=2TU", "FREQ=YEARLY", "FREQ=DAILY;BYHOUR=9", "FREQ=WEEKLY;COUNT=500"]) assert.equal(legacyRepeatFor(rule, mon, "UTC"), null, rule);
	const counted = legacyRepeatFor("FREQ=DAILY;COUNT=3", mon, "UTC");
	assert.equal(counted.repeatUntil.toISOString(), "2026-01-07T09:00:00.001Z");
});

test("legacyRepeatFor takes repeatUntil from UNTIL, however far, and refuses a COUNT it cannot compare", () => {
	const mon = new Date("2026-01-05T09:00:00Z");
	// 400 daily instants end in February 2027; UNTIL is in 2100, so the end must come from UNTIL, not from the compared prefix.
	assert.equal(legacyRepeatFor("FREQ=DAILY;UNTIL=21000101T000000Z", mon, "UTC").repeatUntil.toISOString(), "2100-01-01T00:00:00.001Z");
	assert.equal(legacyRepeatFor("FREQ=WEEKLY;UNTIL=20300101", mon, "UTC").repeatUntil.toISOString(), "2030-01-02T00:00:00.000Z", "a date UNTIL ends after that whole day");
	assert.equal(legacyRepeatFor("FREQ=WEEKLY;UNTIL=20300101", mon, "Europe/Berlin").repeatUntil.toISOString(), "2030-01-01T23:00:00.000Z");
	assert.equal(legacyRepeatFor("FREQ=DAILY;COUNT=400", mon, "UTC").repeat, "daily");
	assert.equal(legacyRepeatFor("FREQ=DAILY;COUNT=401", mon, "UTC"), null);
	assert.equal(legacyRepeatFor("FREQ=DAILY", mon, "UTC").repeatUntil, null, "an endless rule stays endless");
});

function random(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

// The spec's equivalence property: whatever legacyRepeatFor accepts, the real legacy expander gives the same instants as the rule.
test("random legacy-shaped rules: the legacy expander and expandRrule agree over 400 instants", () => {
	const rnd = random(7);
	const zones = ["UTC", "America/Los_Angeles", "Europe/Berlin", "Asia/Kolkata"];
	const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
	let accepted = 0;
	for (let i = 0; i < 120; i++) {
		const zone = zones[Math.floor(rnd() * zones.length)];
		const start = new Date(Date.UTC(2025 + Math.floor(rnd() * 3), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 31), Math.floor(rnd() * 24), rnd() < 0.5 ? 0 : 30));
		const kind = Math.floor(rnd() * 4);
		const set = codes.filter(() => rnd() < 0.4);
		const rule = ["FREQ=DAILY", "FREQ=WEEKLY", `FREQ=WEEKLY;BYDAY=${set.join(",") || "MO"}`, `FREQ=MONTHLY${rnd() < 0.6 ? `;BYMONTHDAY=${1 + Math.floor(rnd() * 31)}` : ""}`][kind] + (rnd() < 0.4 ? `;COUNT=${1 + Math.floor(rnd() * 30)}` : "");
		const legacy = legacyRepeatFor(rule, start, zone);
		if (!legacy) continue;
		accepted++;
		const row = { id: "e", startsAt: start, endsAt: new Date(start.getTime() + 3_600_000), timeZone: zone, title: "", description: "", location: "", attendees: "[]", color: "", excludedOccurrences: "[]", ...legacy, repeatDays: JSON.stringify(legacy.repeatDays) };
		const expected = expandEventOccurrences({ ...row, repeat: "custom", rrule: rule, repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null }, new Date(start.getTime() - 86_400_000), new Date(start.getTime() + 30 * 366 * 86_400_000), 400).map((d) => d.getTime());
		const legacyOut = expandToolEvents([row], new Date(start.getTime() - 86_400_000), new Date(start.getTime() + 30 * 366 * 86_400_000), 400).map((o) => Date.parse(o.startsAt)).sort((a, b) => a - b);
		// The legacy expander scans at most 400 periods per call (400 days for a weekday set), so it can stop earlier than the 400 instants asked for.
		assert.ok(legacyOut.length > 0, rule);
		assert.deepEqual(legacyOut, expected.slice(0, legacyOut.length), `${rule} ${zone} ${start.toISOString()}`);
		if (legacy.repeatUntil || legacy.repeat === "none") assert.equal(legacyOut.length, expected.length, `${rule} length`);
	}
	assert.ok(accepted > 30, `only ${accepted} generated rules were representable`);
});

test("legacy rows expand through the same path as the legacy expanders", () => {
	const start = new Date("2026-03-30T08:00:00Z");
	const row = { startsAt: start, endsAt: new Date(start.getTime() + 1800_000), timeZone: "Europe/Berlin", repeat: "weekdays", repeatDays: "[1,3,5]", repeatAnchorDay: null, repeatUntil: new Date("2026-05-01T00:00:00Z"), excludedOccurrences: "[]" };
	const a = expandEventStarts(row, start, FAR, 400).map((d) => d.getTime());
	const b = expandToolEvents([{ ...row, id: "e", title: "", description: "", location: "", attendees: "[]", color: "" }], start, FAR, 400).map((o) => Date.parse(o.startsAt)).sort((x, y) => x - y);
	assert.deepEqual(a, b);
	assert.equal(legacyRrule({ repeat: "none", repeatDays: [], repeatAnchorDay: null, repeatUntil: null }), null);
});

test("a COUNT walk always completes: a long series from far back expands into today, fast", () => {
	for (const [rule, start, expected] of [
		["FREQ=YEARLY;COUNT=100", "1960-03-15T09:00:00Z", ["2026-03-15T09:00:00.000Z"]],
		["FREQ=MONTHLY;COUNT=1000", "1960-01-15T09:00:00Z", Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(2026, month, 15, 9)).toISOString())],
	]) {
		const begin = performance.now();
		const found = expandRrule(parseRrule(rule, "UTC"), new Date(start), "UTC", new Date("2026-01-01T00:00:00Z"), new Date("2027-01-01T00:00:00Z"), 100).map((d) => d.toISOString());
		const elapsed = performance.now() - begin;
		assert.deepEqual(found, expected, rule);
		assert.ok(elapsed < 100, `${rule} took ${elapsed.toFixed(0)} ms`);
	}
});

test("limitRrule leaves a COUNT rule alone when its end could not be computed, never turning COUNT into a later UNTIL", () => {
	const start = new Date("1960-01-04T09:00:00Z");
	// 3000 weekly occurrences end in 2017: the walk completes and the series stays ended.
	assert.equal(limitRrule("FREQ=WEEKLY;COUNT=3000", new Date("2026-06-01T00:00:00Z"), start, "UTC", false), "FREQ=WEEKLY;COUNT=3000");
	// Only Februaries: the work budget runs out (about 2080) before COUNT does. A cut past what was walked is unknown, so unchanged.
	const sparse = "FREQ=DAILY;BYMONTH=2;COUNT=5000";
	const feb = new Date("2026-02-01T09:00:00Z");
	assert.equal(limitRrule(sparse, new Date("2100-06-01T00:00:00Z"), feb, "UTC", false), sparse);
	assert.equal(rruleEndedBefore(sparse, feb, "UTC", new Date("2100-06-01T00:00:00Z")), false);
	// A cut inside the walked part still cuts.
	assert.equal(limitRrule(sparse, new Date("2030-06-01T00:00:00Z"), feb, "UTC", false), "FREQ=DAILY;BYMONTH=2;UNTIL=20300531T235959Z");
});

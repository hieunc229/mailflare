import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-custom-repeat-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: {
		tools: join(root, "src/lib/calendar/tool-occurrences.ts"),
		ui: join(root, "src/app/(calendar)/calendar/utils.ts"),
		avail: join(root, "src/lib/booking/availability.ts"),
		status: join(root, "src/lib/calendar/response-status.ts"),
		fields: join(root, "src/lib/calendar/repeat-fields.ts"),
		store: join(root, "src/lib/calendar/invite-store.ts"),
		feed: join(root, "src/lib/calendar/feed.ts"),
	},
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@": join(root, "src") },
	external: ["better-sqlite3", "pg", "postgres", "mysql2", "@neondatabase/serverless", "@planetscale/database", "@libsql/client", "@electric-sql/pglite", "bun:sqlite", "cloudflare:workers"],
});
const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const { expandToolEvents } = await load("tools");
const { expandCalendarEvents, nextCalendarOccurrence } = await load("ui");
const { repeatsDuring, busyCheck } = await load("avail");
const { isInactiveCalendarResponse, isOffCalendarResponse, OFF_CALENDAR_RESPONSES } = await load("status");
const { editedTimeZone, resolveRepeat, repeatForToolUpdate, isConsistentRepeat, shiftCustomSeries, sameZonedDay } = await load("fields");
const { inviteEventValues } = await load("store");
const { buildCalendarFeed } = await load("feed");

const row = (extra = {}) => ({
	id: "evt_1", userId: "u1", title: "Sprint", description: "", location: "", attendees: "[]", color: "blue", repeat: "custom", rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
	repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", timeZone: "UTC", responseStatus: null,
	startsAt: new Date("2026-01-05T09:00:00Z"), endsAt: new Date("2026-01-05T10:00:00Z"), ...extra,
});

test("tool expansion (MCP, reminders) walks a custom rule and honours exclusions", () => {
	const skipped = Date.parse("2026-01-19T09:00:00Z");
	const out = expandToolEvents([row({ excludedOccurrences: JSON.stringify([skipped]) })], new Date("2026-01-01"), new Date("2026-02-10"));
	assert.deepEqual(out.map((o) => o.startsAt), ["2026-01-05T09:00:00.000Z", "2026-02-02T09:00:00.000Z"]);
	assert.equal(out[0].id, `evt_1@${Date.parse("2026-01-05T09:00:00Z")}`);
	assert.equal(out[0].seriesId, "evt_1");
	assert.equal(out[0].repeat, "custom");
});

test("tool expansion hides declined and cancelled events", () => {
	for (const responseStatus of ["declined", "cancelled"]) assert.deepEqual(expandToolEvents([row({ repeat: "none", rrule: null, responseStatus })], new Date("2026-01-01"), new Date("2026-02-10")), []);
	assert.equal(expandToolEvents([row({ repeat: "none", rrule: null, responseStatus: "accepted" })], new Date("2026-01-01"), new Date("2026-02-10")).length, 1);
});

const clientEvent = (extra = {}) => ({ ...row(), startsAt: "2026-01-05T09:00:00.000Z", endsAt: "2026-01-05T10:00:00.000Z", repeatUntil: null, ...extra });

test("calendar view expansion and next occurrence handle a custom rule", () => {
	const out = expandCalendarEvents([clientEvent()], new Date("2026-01-01"), new Date("2026-02-10"));
	assert.deepEqual(out.map((o) => o.startsAt), ["2026-01-05T09:00:00.000Z", "2026-01-19T09:00:00.000Z", "2026-02-02T09:00:00.000Z"]);
	assert.equal(out[1].seriesStartsAt, "2026-01-05T09:00:00.000Z");
	assert.equal(nextCalendarOccurrence(clientEvent(), new Date("2026-01-06")).toISOString(), "2026-01-19T09:00:00.000Z");
});

test("booking availability sees custom occurrences and ignores exclusions", () => {
	const event = row();
	assert.equal(repeatsDuring(event, new Date("2026-02-02T09:15:00Z"), new Date("2026-02-02T09:45:00Z")), true);
	assert.equal(repeatsDuring(event, new Date("2026-02-09T09:15:00Z"), new Date("2026-02-09T09:45:00Z")), false);
	assert.equal(repeatsDuring(row({ excludedOccurrences: JSON.stringify([Date.parse("2026-02-02T09:00:00Z")]) }), new Date("2026-02-02T09:15:00Z"), new Date("2026-02-02T09:45:00Z")), false);
});

test("response status helpers", () => {
	assert.deepEqual([OFF_CALENDAR_RESPONSES].flat().sort(), ["cancelled", "declined", "needs-action"]);
	for (const [status, inactive, off] of [[null, false, false], ["accepted", false, false], ["tentative", false, false], ["needs-action", false, true], ["declined", true, true], ["cancelled", true, true]]) {
		assert.equal(isInactiveCalendarResponse(status), inactive, String(status));
		assert.equal(isOffCalendarResponse(status), off, String(status));
	}
});

test("the feed emits the stored rule and exclusions for a custom event", () => {
	const ics = buildCalendarFeed([row({ excludedOccurrences: JSON.stringify([Date.parse("2026-01-19T09:00:00Z")]), timeZone: "Europe/Berlin" })], { name: "M", now: new Date("2026-01-01T00:00:00Z") });
	assert.match(ics, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO\r\n/);
	assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20260105T100000\r\n/);
	assert.match(ics, /EXDATE;TZID=Europe\/Berlin:20260119T100000\r\n/);
	assert.doesNotMatch(buildCalendarFeed([row({ rrule: null })], { name: "M" }), /RRULE/);
});

// Both forms are kept: `repeat = custom` exactly when `rrule` is set, and a custom row carries no legacy columns.
test("isConsistentRepeat describes the invariant", () => {
	assert.ok(isConsistentRepeat(row()));
	assert.ok(isConsistentRepeat(row({ repeat: "weekly", rrule: null })));
	assert.ok(!isConsistentRepeat(row({ repeat: "custom", rrule: null })));
	assert.ok(!isConsistentRepeat(row({ repeat: "weekly" })));
	assert.ok(!isConsistentRepeat(row({ repeatAnchorDay: 3 })));
	assert.ok(!isConsistentRepeat(row({ repeatUntil: new Date() })));
	assert.ok(!isConsistentRepeat(row({ repeatDays: "[1]" })));
});

const legacyRow = (extra = {}) => row({ repeat: "weekdays", rrule: null, repeatDays: "[1,3]", repeatAnchorDay: null, repeatUntil: new Date("2026-06-01T00:00:00Z"), ...extra });

test("editing a custom event keeps its rule unless another repeat is chosen", () => {
	for (const repeat of [undefined, "custom"]) {
		const out = resolveRepeat(row(), { repeat, repeatDays: [1], repeatAnchorDay: 4 });
		assert.deepEqual(out, { repeat: "custom", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" });
	}
	const weekly = resolveRepeat(row(), { repeat: "weekly" });
	assert.equal(weekly.repeat, "weekly");
	assert.equal(weekly.rrule, null);
	assert.ok(isConsistentRepeat(weekly));
});

test("a client cannot create or set a custom repeat without a rule", () => {
	assert.equal(resolveRepeat(null, { repeat: "custom" }).repeat, "none");
	assert.equal(resolveRepeat(row({ rrule: null }), {}).repeat, "none", "a custom row that lost its rule reads as one-off");
});

test("asking for custom on a row that has no rule changes nothing", () => {
	assert.deepEqual(resolveRepeat(legacyRow(), { repeat: "custom" }), resolveRepeat(legacyRow(), {}));
	assert.equal(resolveRepeat(legacyRow(), { repeat: "custom" }).repeat, "weekdays");
	assert.equal(resolveRepeat(legacyRow({ repeat: "daily", repeatDays: "[]" }), { repeat: "custom" }).repeat, "daily");
	const start = new Date("2026-01-05T09:00:00Z");
	assert.equal(repeatForToolUpdate(legacyRow(), { repeat: "custom" }, start, "UTC").repeat, "weekdays");
});

test("legacy edits behave as before and never set a rule", () => {
	assert.deepEqual(resolveRepeat(legacyRow(), {}), { repeat: "weekdays", repeatDays: "[1,3]", repeatAnchorDay: null, repeatUntil: new Date("2026-06-01T00:00:00Z"), rrule: null });
	assert.equal(resolveRepeat(null, { repeat: "weekdays", repeatDays: [] }), null);
	assert.deepEqual(resolveRepeat(null, { repeat: "monthly", repeatAnchorDay: 12 }), { repeat: "monthly", repeatDays: "[]", repeatAnchorDay: 12, repeatUntil: null, rrule: null });
	assert.equal(resolveRepeat(legacyRow(), { repeat: "none" }).repeatUntil, null);
});

test("MCP updates keep or clear the rule the same way", () => {
	const start = new Date("2026-01-05T09:00:00Z");
	const keep = repeatForToolUpdate(row(), {}, start, "UTC");
	assert.deepEqual(keep, { repeat: "custom", repeatDays: "[]", repeatAnchorDay: null, rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" });
	const changed = repeatForToolUpdate(row(), { repeat: "monthly" }, start, "UTC");
	assert.deepEqual(changed, { repeat: "monthly", repeatDays: "[]", repeatAnchorDay: 5, rrule: null });
	const plain = repeatForToolUpdate(legacyRow(), { repeatDays: [2, 4] }, start, "UTC");
	assert.deepEqual(plain, { repeat: "weekdays", repeatDays: "[2,4]", repeatAnchorDay: null, rrule: null });
});

test("MCP: switching a custom or one-off row to weekdays without days uses the start's weekday, never an empty list", () => {
	const monday = new Date("2026-01-05T09:00:00Z");
	assert.equal(repeatForToolUpdate(row(), { repeat: "weekdays" }, monday, "UTC").repeatDays, "[1]");
	assert.equal(repeatForToolUpdate(row({ repeat: "none", rrule: null }), { repeat: "weekdays" }, new Date("2026-01-07T23:30:00Z"), "Asia/Tokyo").repeatDays, "[4]", "the weekday in the event zone");
	assert.equal(repeatForToolUpdate(row(), { repeat: "weekdays", repeatDays: [2, 4] }, monday, "UTC").repeatDays, "[2,4]");
	assert.equal(repeatForToolUpdate(legacyRow(), { repeat: "weekdays" }, monday, "UTC").repeatDays, "[1,3]", "a weekdays row keeps its days");
});

test("a custom series may only change time of day: another day is refused", () => {
	const existing = { startsAt: new Date("2026-01-05T09:00:00Z"), excludedOccurrences: "[]" };
	assert.equal(shiftCustomSeries(existing, new Date("2026-01-06T09:00:00Z"), "UTC"), null);
	assert.equal(shiftCustomSeries(existing, new Date("2026-01-04T23:59:00Z"), "UTC"), null);
	assert.equal(shiftCustomSeries(existing, new Date("2026-01-05T23:59:00Z"), "UTC").moved, true);
	assert.equal(shiftCustomSeries(existing, new Date("2026-01-05T09:00:00Z"), "UTC").moved, false);
	// The day is the one in the event zone: 09:00 UTC Monday is already Monday evening in Tokyo, and 16:00 UTC is Tuesday there.
	assert.ok(shiftCustomSeries(existing, new Date("2026-01-05T14:00:00Z"), "Asia/Tokyo"));
	assert.equal(shiftCustomSeries(existing, new Date("2026-01-05T16:00:00Z"), "Asia/Tokyo"), null);
	assert.ok(sameZonedDay(new Date("2026-01-05T00:00:00Z"), new Date("2026-01-05T23:59:59Z"), "UTC"));
});

test("a time-of-day shift moves exclusions and override recurrence ids by the same wall-clock delta", () => {
	const existing = { startsAt: new Date("2026-01-05T09:00:00Z"), excludedOccurrences: JSON.stringify([Date.parse("2026-01-19T09:00:00Z"), Date.parse("2026-02-02T09:00:00Z")]) };
	const shifted = shiftCustomSeries(existing, new Date("2026-01-05T10:30:00Z"), "UTC");
	assert.deepEqual(JSON.parse(shifted.excludedOccurrences), [Date.parse("2026-01-19T10:30:00Z"), Date.parse("2026-02-02T10:30:00Z")]);
	assert.equal(shifted.shift(new Date("2026-03-02T09:00:00Z")).toISOString(), "2026-03-02T10:30:00.000Z");
	// Across a DST change the delta is wall-clock: Berlin 10:00 stays 10:00 -> 11:00 in summer too (09:00Z winter, 08:00Z summer).
	const berlin = shiftCustomSeries({ startsAt: new Date("2026-01-05T09:00:00Z"), excludedOccurrences: JSON.stringify([Date.parse("2026-07-06T08:00:00Z")]) }, new Date("2026-01-05T10:00:00Z"), "Europe/Berlin");
	assert.deepEqual(JSON.parse(berlin.excludedOccurrences), [Date.parse("2026-07-06T09:00:00Z")]);
	// The shifted exclusion still hides the shifted occurrence.
	const rule = row({ startsAt: new Date("2026-01-05T10:30:00Z"), endsAt: new Date("2026-01-05T11:30:00Z"), excludedOccurrences: shifted.excludedOccurrences });
	assert.deepEqual(expandToolEvents([rule], new Date("2026-01-01"), new Date("2026-02-10")).map((o) => o.startsAt), ["2026-01-05T10:30:00.000Z"]);
});

test("busyCheck expands a custom rule once for the window and agrees with repeatsDuring", () => {
	const events = [row({ rrule: "FREQ=DAILY;COUNT=5000", startsAt: new Date("2016-01-04T09:00:00Z"), endsAt: new Date("2016-01-04T10:00:00Z") }), row({ id: "evt_2", repeat: "weekly", rrule: null, startsAt: new Date("2026-03-02T15:00:00Z"), endsAt: new Date("2026-03-02T16:00:00Z") })];
	const from = new Date("2026-03-09T00:00:00Z");
	const to = new Date("2026-03-23T00:00:00Z");
	const begin = performance.now();
	const busy = busyCheck(events, from, to);
	let hits = 0;
	for (let at = from.getTime(); at < to.getTime(); at += 900_000) {
		const slot = [new Date(at), new Date(at + 1_800_000)];
		const got = busy(...slot);
		assert.equal(got, events.some((event) => repeatsDuring(event, ...slot)), new Date(at).toISOString());
		if (got) hits++;
	}
	assert.equal(hits, 80, `${hits} busy slots`);
	assert.ok(performance.now() - begin < 3000, "per-slot cost stays bounded");
});

test("an invitation whose rule the legacy columns cannot hold is stored as a custom repeat", () => {
	const base = { title: "T", description: "", location: "", sequence: 1, startsAt: new Date("2026-01-05T09:00:00Z"), endsAt: new Date("2026-01-05T10:00:00Z"), excludedDates: [] };
	for (const rrule of ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "FREQ=MONTHLY;BYDAY=2TU", "FREQ=YEARLY", "FREQ=WEEKLY;BYDAY=TU,WE"]) {
		const values = inviteEventValues({ ...base, rrule }, "UTC", "[]");
		assert.equal(values.repeat, "custom", rrule);
		assert.equal(values.rrule, rrule);
		assert.ok(isConsistentRepeat(values), rrule);
	}
	assert.equal(inviteEventValues({ ...base, rrule: "RRULE:FREQ=YEARLY;COUNT=3" }, "UTC", "[]").rrule, "FREQ=YEARLY;COUNT=3");
	// Expressible rules and rules the parser rejects keep the legacy mapping.
	assert.equal(inviteEventValues({ ...base, rrule: "FREQ=WEEKLY" }, "UTC", "[]").repeat, "weekly");
	assert.equal(inviteEventValues({ ...base, rrule: "FREQ=WEEKLY" }, "UTC", "[]").rrule, null);
	assert.equal(inviteEventValues({ ...base, rrule: "FREQ=DAILY;BYHOUR=9" }, "UTC", "[]").rrule, null);
	assert.equal(inviteEventValues({ ...base, rrule: null }, "UTC", "[]").repeat, "none");
});

test("an updated invitation writes legacy repeat columns and no rule when the legacy columns can hold it", () => {
	const invite = { title: "T", description: "", location: "", sequence: 1, startsAt: new Date("2026-01-05T09:00:00Z"), endsAt: new Date("2026-01-05T10:00:00Z"), rrule: "FREQ=WEEKLY;COUNT=3", excludedDates: [] };
	const values = inviteEventValues(invite, "UTC", "[]");
	assert.equal(values.rrule, null);
	assert.equal(values.repeat, "weekly");
	assert.ok(isConsistentRepeat({ ...values }));
	assert.equal(inviteEventValues({ ...invite, rrule: "FREQ=DAILY" }, "UTC", "[]").repeat, "daily");
});

test("a kept custom rule keeps its saved zone: the editor's zone is ignored, so occurrences do not move", () => {
	const ny = row({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE", timeZone: "America/New_York", startsAt: new Date("2026-01-05T14:00:00Z"), endsAt: new Date("2026-01-05T15:00:00Z") });
	const window = [new Date("2026-06-01"), new Date("2026-06-15")];
	const before = expandToolEvents([ny], ...window).map((o) => o.startsAt);
	// A title edit from a browser in Kolkata sends its own zone (no repeat change).
	const zone = editedTimeZone(ny, undefined, "Asia/Kolkata");
	assert.equal(zone, "America/New_York");
	assert.equal(editedTimeZone(ny, "custom", "Asia/Kolkata"), "America/New_York");
	assert.deepEqual(expandToolEvents([{ ...ny, timeZone: zone, title: "Renamed" }], ...window).map((o) => o.startsAt), before);
	assert.ok(shiftCustomSeries(ny, ny.startsAt, zone), "the same time is not a day change in the saved zone");
	// Choosing another repeat, or a row without a rule, takes the requested zone as before.
	assert.equal(editedTimeZone(ny, "daily", "Asia/Tokyo"), "Asia/Tokyo");
	assert.equal(editedTimeZone({ rrule: null, timeZone: "America/New_York" }, undefined, "Asia/Tokyo"), "Asia/Tokyo");
	assert.equal(editedTimeZone({ rrule: null, timeZone: "America/New_York" }, undefined, undefined), "America/New_York");
});

test("busyCheck fails closed: a rule whose walk hit the work budget is busy for the whole window", () => {
	// Februaries only, COUNT 5000: the budget (about 55 years) ends in the 2080s with no occurrence seen after the window, so the answer is unknown.
	const sparse = row({ rrule: "FREQ=DAILY;BYMONTH=2;COUNT=5000", startsAt: new Date("2026-02-01T09:00:00Z"), endsAt: new Date("2026-02-01T10:00:00Z") });
	const busy = busyCheck([sparse], new Date("2100-06-01T00:00:00Z"), new Date("2100-06-15T00:00:00Z"));
	assert.equal(busy(new Date("2100-06-03T12:00:00Z"), new Date("2100-06-03T12:30:00Z")), true);
	// A rule that walked completely is exact: no occurrence in June 2100 means free.
	const exact = row({ rrule: "FREQ=DAILY;BYMONTH=2", startsAt: new Date("2026-02-01T09:00:00Z"), endsAt: new Date("2026-02-01T10:00:00Z") });
	assert.equal(busyCheck([exact], new Date("2100-06-01T00:00:00Z"), new Date("2100-06-15T00:00:00Z"))(new Date("2100-06-03T12:00:00Z"), new Date("2100-06-03T12:30:00Z")), false);
});

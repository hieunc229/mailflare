import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-ics-import-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { i: join(root, "src/lib/calendar/ics-import.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
await build({
	entryPoints: { t: join(root, "src/lib/calendar/tool-occurrences.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { expandToolEvents } = await import(pathToFileURL(join(dir, "t.mjs")).href);
const { parseIcsEventGroup, readIcsLines, splitIcsEvents, icsHtmlToText, MAX_LINE_BYTES } = await import(pathToFileURL(join(dir, "i.mjs")).href);

const opts = { userZone: "America/New_York", ownAddresses: ["me@example.com"], reminders: true, skipDeclined: true };
const vevent = (...lines) => ["BEGIN:VEVENT", "UID:u1", ...lines, "END:VEVENT"].join("\r\n");
const parse = (text, over = {}) => parseIcsEventGroup(text, { ...opts, ...over });
const bytes = (text) => new TextEncoder().encode(text);

test("folded lines unfold on bytes, including a fold inside a multi-byte character", () => {
	const raw = Buffer.concat([Buffer.from("SUMMARY:Caf"), Buffer.from([0xc3]), Buffer.from("\r\n "), Buffer.from([0xa9]), Buffer.from(" au lait\r\n")]);
	assert.deepEqual(readIcsLines(raw), ["SUMMARY:Café au lait"]);
	assert.deepEqual(readIcsLines(bytes("A:1\rB:2\nC:3\r\nD:4\r\n\tmore")), ["A:1", "B:2", "C:3", "D:4more"]);
});

test("a line over the cap is truncated, not buffered whole", () => {
	const lines = readIcsLines(bytes(`DESCRIPTION:${"x".repeat(MAX_LINE_BYTES * 3)}\r\nUID:a`));
	assert.equal(lines.length, 2);
	assert.ok(lines[0].length <= MAX_LINE_BYTES);
	assert.equal(lines[1], "UID:a");
});

test("title, escapes, description and zones", () => {
	const g = parse(vevent("DTSTART;TZID=America/New_York:20261104T090000", "DTEND;TZID=America/New_York:20261104T100000", "SUMMARY:Planning\\, Q4\\; ok", "DESCRIPTION:one\\ntwo", "LOCATION:Room 1"));
	assert.equal(g.master.title, "Planning, Q4; ok");
	assert.equal(g.master.description, "one\ntwo");
	assert.equal(g.master.location, "Room 1");
	assert.equal(g.master.timeZone, "America/New_York");
	assert.equal(g.master.startsAt.toISOString(), "2026-11-04T14:00:00.000Z");
	assert.equal(g.master.endsAt.toISOString(), "2026-11-04T15:00:00.000Z");
	assert.equal(g.guessedZone, false);
	const windows = parse(vevent("DTSTART;TZID=Pacific Standard Time:20261104T090000", "SUMMARY:w"));
	assert.equal(windows.master.timeZone, "America/Los_Angeles");
	assert.equal(windows.master.endsAt.getTime() - windows.master.startsAt.getTime(), 3_600_000);
	const unknown = parse(vevent("DTSTART;TZID=Custom/Nowhere:20261104T090000", "SUMMARY:u"));
	assert.equal(unknown.guessedZone, true);
	assert.equal(unknown.master.timeZone, "America/New_York");
	assert.equal(unknown.master.startsAt.toISOString(), "2026-11-04T14:00:00.000Z");
	assert.equal(parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:z")).master.timeZone, "America/New_York");
	assert.equal(parse(vevent("DTSTART:20261104T090000Z")).master.title, "(no title)");
});

test("all-day events become midnight to midnight in the user's zone", () => {
	const one = parse(vevent("DTSTART;VALUE=DATE:20261104", "DTEND;VALUE=DATE:20261105", "SUMMARY:d"));
	assert.equal(one.master.startsAt.toISOString(), "2026-11-04T05:00:00.000Z");
	assert.equal(one.master.endsAt.toISOString(), "2026-11-05T05:00:00.000Z");
	assert.equal(one.master.timeZone, "America/New_York");
	assert.equal(one.guessedZone, false);
	const multi = parse(vevent("DTSTART;VALUE=DATE:20261104", "DTEND;VALUE=DATE:20261107", "SUMMARY:d"));
	assert.equal(multi.master.endsAt.toISOString(), "2026-11-07T05:00:00.000Z");
	assert.equal(parse(vevent("DTSTART;VALUE=DATE:20261104", "SUMMARY:d")).master.endsAt.toISOString(), "2026-11-05T05:00:00.000Z");
});

test("recurrence: weekly BYDAY, COUNT, and rules Mailflare cannot store become one event", () => {
	const weekdays = parse(vevent("DTSTART;TZID=America/New_York:20261102T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", "SUMMARY:r"));
	assert.equal(weekdays.master.repeat, "weekdays");
	assert.deepEqual(weekdays.master.repeatDays, [1, 3, 5]);
	assert.equal(weekdays.simplified, false);
	const count = parse(vevent("DTSTART;TZID=America/New_York:20261102T090000", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:r"));
	assert.equal(count.master.repeat, "daily");
	assert.equal(count.master.repeatUntil.toISOString(), "2026-11-04T14:00:01.000Z");
	for (const rule of ["FREQ=WEEKLY;INTERVAL=2", "FREQ=YEARLY", "FREQ=MONTHLY;BYDAY=2TU", "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR", "FREQ=WEEKLY;BYMONTH=3", "FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=WEEKLY;BYDAY=TU"]) {
		const g = parse(vevent("DTSTART;TZID=America/New_York:20261102T090000", `RRULE:${rule}`, "SUMMARY:s"));
		assert.equal(g.simplified, true, rule);
		assert.equal(g.master.repeat, "none", rule);
		assert.equal(g.master.startsAt.toISOString(), "2026-11-02T14:00:00.000Z", rule);
	}
	const rdate = parse(vevent("DTSTART;TZID=America/New_York:20261102T090000", "RRULE:FREQ=DAILY", "RDATE:20261201T090000Z", "SUMMARY:s"));
	assert.equal(rdate.simplified, true);
	const plain = parse(vevent("DTSTART;TZID=America/New_York:20261102T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:s"));
	assert.equal(plain.master.repeat, "weekly");
	assert.equal(plain.simplified, false);
	assert.equal(parse(vevent("DTSTART:20261102T090000Z", "SUMMARY:n")).simplified, false);
});

test("EXDATE, overrides and cancellations", () => {
	const master = ["BEGIN:VEVENT", "UID:u1", "DTSTART;TZID=America/New_York:20261102T090000", "RRULE:FREQ=DAILY", "EXDATE;TZID=America/New_York:20261103T090000", "SUMMARY:Series", "END:VEVENT"];
	const moved = ["BEGIN:VEVENT", "UID:u1", "RECURRENCE-ID;TZID=America/New_York:20261104T090000", "DTSTART;TZID=America/New_York:20261104T110000", "SUMMARY:Moved", "END:VEVENT"];
	const cancelled = ["BEGIN:VEVENT", "UID:u1", "RECURRENCE-ID;TZID=America/New_York:20261105T090000", "DTSTART;TZID=America/New_York:20261105T090000", "STATUS:CANCELLED", "SUMMARY:Gone", "END:VEVENT"];
	const g = parse([...master, ...moved, ...cancelled].join("\r\n"));
	assert.deepEqual(g.master.excluded.map((d) => d.toISOString()), ["2026-11-03T14:00:00.000Z", "2026-11-04T14:00:00.000Z", "2026-11-05T14:00:00.000Z"]);
	assert.equal(g.overrides.length, 1);
	assert.equal(g.overrides[0].title, "Moved");
	assert.equal(g.overrides[0].repeat, "none");
	assert.equal(g.overrides[0].recurrenceId.toISOString(), "2026-11-04T14:00:00.000Z");
	const gone = parse(["BEGIN:VEVENT", "UID:u1", "DTSTART:20261102T090000Z", "STATUS:CANCELLED", "SUMMARY:x", "END:VEVENT"].join("\r\n"));
	assert.equal(gone.master, null);
	assert.equal(gone.skipped, 1);
	// An override with no master is a one-off event; one on a simplified master's own date replaces it.
	assert.equal(parse(moved.join("\r\n")).overrides.length, 1);
	const simple = ["BEGIN:VEVENT", "UID:u1", "DTSTART;TZID=America/New_York:20261104T090000", "RRULE:FREQ=YEARLY", "SUMMARY:Y", "END:VEVENT"];
	const sg = parse([...simple, ...moved].join("\r\n"));
	assert.equal(sg.master, null);
	assert.equal(sg.overrides.length, 1);
});

test("reminders: smallest relative DISPLAY alarm before START, END-related ignored", () => {
	const alarm = (...lines) => ["BEGIN:VALARM", ...lines, "END:VALARM"];
	const base = (...alarms) => ["BEGIN:VEVENT", "UID:u1", "DTSTART:20261104T090000Z", "SUMMARY:a", ...alarms.flat(), "END:VEVENT"].join("\r\n");
	assert.equal(parse(base(alarm("ACTION:DISPLAY", "TRIGGER:-PT30M"), alarm("ACTION:DISPLAY", "TRIGGER:-P1D"))).master.reminderMinutes, 30);
	assert.equal(parse(base(alarm("ACTION:DISPLAY", "TRIGGER;RELATED=END:-PT5M"))).master.reminderMinutes, null);
	assert.equal(parse(base(alarm("ACTION:DISPLAY", "TRIGGER;VALUE=DATE-TIME:20261104T080000Z"))).master.reminderMinutes, null);
	assert.equal(parse(base(alarm("ACTION:EMAIL", "TRIGGER:-PT10M"), alarm("ACTION:DISPLAY", "TRIGGER:-PT20M"))).master.reminderMinutes, 20);
	assert.equal(parse(base(alarm("ACTION:EMAIL", "TRIGGER:-PT10M"))).master.reminderMinutes, 10);
	assert.equal(parse(base(alarm("ACTION:DISPLAY", "TRIGGER:-P30D"))).master.reminderMinutes, null);
	assert.equal(parse(base(alarm("ACTION:DISPLAY", "TRIGGER:-PT30M")), { reminders: false }).master.reminderMinutes, null);
});

test("attendees: own address removed, declined skipped, organizer and conference lines", () => {
	const lines = ["DTSTART:20261104T090000Z", "SUMMARY:m",
		"ORGANIZER;CN=\"Boss, The\":mailto:boss@example.com",
		"ATTENDEE;PARTSTAT=ACCEPTED:mailto:Me@Example.com", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:a@x.org", "ATTENDEE:mailto:bad address@x.org", "ATTENDEE:mailto:a@x.org"];
	const g = parse(vevent(...lines));
	assert.deepEqual(g.master.attendees, ["a@x.org"]);
	assert.match(g.master.description, /Organizer: Boss, The <boss@example.com>/);
	const declined = parse(vevent(...lines.map((l) => l.replace("ACCEPTED", "DECLINED"))));
	assert.equal(declined.master, null);
	assert.equal(declined.skipped, 1);
	assert.notEqual(parse(vevent(...lines.map((l) => l.replace("ACCEPTED", "DECLINED"))), { skipDeclined: false }).master, null);
	const own = parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:m", "ORGANIZER:mailto:me@example.com"));
	assert.equal(own.master.description, "");
	const many = parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:m", ...Array.from({ length: 300 }, (_, n) => `ATTENDEE:mailto:p${n}@x.org`)));
	assert.equal(many.master.attendees.length, 100);
});

test("Google conference link becomes one Join line; only https is kept", () => {
	const g = parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:c", "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
		"DESCRIPTION:Agenda\\n\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-\\nJoin: https://meet.google.com/abc-defg-hij\\nMore"));
	assert.equal(g.master.description, "Agenda\n\nJoin: https://meet.google.com/abc-defg-hij");
	assert.equal(g.master.location, "https://meet.google.com/abc-defg-hij");
	const bad = parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:c", "X-GOOGLE-CONFERENCE:javascript:alert(1)", "URL:http://insecure.example", "LOCATION:Office"));
	assert.equal(bad.master.description, "");
	assert.equal(bad.master.location, "Office");
	const url = parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:c", "URL:https://example.com/x"));
	assert.equal(url.master.description, "https://example.com/x");
});

test("HTML descriptions become text without regex backtracking", () => {
	assert.equal(icsHtmlToText("Hi<br>there<p>para</p><a href=\"https://x\">link</a> &amp;&lt;b&gt; &quot;q&quot; &#39;s&#39;"), "Hi\nthere\npara\nlink &<b> \"q\" 's'");
	assert.equal(icsHtmlToText("plain text < not a tag"), "plain text < not a tag");
	const started = Date.now();
	const out = icsHtmlToText("<".repeat(100_000));
	assert.ok(Date.now() - started < 500);
	assert.ok(out.length <= 100_000);
	assert.equal(parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:h", "DESCRIPTION:a<br>b")).master.description, "a\nb");
});

test("oversized fields are capped and control characters removed", () => {
	const g = parse(vevent("DTSTART:20261104T090000Z", `SUMMARY:${"t".repeat(5000)}\u0007bell`, `LOCATION:${"l".repeat(5000)}`, `DESCRIPTION:${"d".repeat(30000)}`));
	assert.equal(g.master.title.length, 500);
	assert.ok(!/[\u0007]/.test(g.master.title));
	assert.equal(g.master.location.length, 500);
	assert.ok(g.master.description.length <= 10_000);
	const exdates = Array.from({ length: 2000 }, (_, n) => `EXDATE:2027${String(1 + (n % 12)).padStart(2, "0")}${String(1 + (n % 28)).padStart(2, "0")}T0${n % 10}0000Z`);
	const many = parse(vevent("DTSTART:20261104T090000Z", "RRULE:FREQ=DAILY", "SUMMARY:e", ...exdates));
	assert.ok(many.master.excluded.length <= 1000);
});

test("monthly series anchored after the 28th become one event, because Mailflare clamps to month end and Google skips", () => {
	for (const [start, rule] of [["20270131", "FREQ=MONTHLY;COUNT=4"], ["20270131", "FREQ=MONTHLY;BYMONTHDAY=31"], ["20270129", "FREQ=MONTHLY;BYMONTHDAY=29;COUNT=3"], ["20270130", "FREQ=MONTHLY"]]) {
		const g = parse(vevent(`DTSTART:${start}T090000Z`, `RRULE:${rule}`, "SUMMARY:m"));
		assert.equal(g.master.repeat, "none", rule);
		assert.equal(g.simplified, true, rule);
	}
	const ok = parse(vevent("DTSTART:20270128T090000Z", "RRULE:FREQ=MONTHLY;COUNT=4", "SUMMARY:m"));
	assert.equal(ok.master.repeat, "monthly");
	assert.equal(ok.simplified, false);
});

test("a recurring event with a UTC start is stored in UTC, so expansion and EXDATEs agree across a DST change", () => {
	const row = (g) => ({ ...g.master, id: "x", attendees: "[]", color: "", repeatDays: JSON.stringify(g.master.repeatDays), excludedOccurrences: JSON.stringify(g.master.excluded.map((d) => d.getTime())) });
	const range = [new Date("2026-10-26T00:00:00Z"), new Date("2026-12-01T00:00:00Z")];
	const weekly = parse(vevent("DTSTART:20261030T140000Z", "DTEND:20261030T150000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20261113T140000Z", "SUMMARY:w"));
	assert.equal(weekly.master.timeZone, "UTC");
	const times = expandToolEvents([row(weekly)], ...range).map((e) => e.startsAt);
	assert.ok(times.every((t) => t.endsWith("T14:00:00.000Z")), times.join());
	assert.ok(!times.includes("2026-11-13T14:00:00.000Z"));
	assert.ok(times.includes("2026-11-06T14:00:00.000Z") && times.includes("2026-11-20T14:00:00.000Z"));
	// 01:00Z on a Tuesday is Monday evening in New York: the days must stay Tuesday and Thursday.
	const evening = parse(vevent("DTSTART:20261027T010000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU,TH", "SUMMARY:e"));
	const days = expandToolEvents([row(evening)], ...range).map((e) => new Date(e.startsAt).getUTCDay());
	assert.ok(days.length > 8 && days.every((day) => day === 2 || day === 4), days.join());
	// Floating and all-day events keep the user's zone; so does a single UTC event.
	assert.equal(parse(vevent("DTSTART:20261030T140000", "RRULE:FREQ=WEEKLY", "SUMMARY:f")).master.timeZone, "America/New_York");
	assert.equal(parse(vevent("DTSTART;VALUE=DATE:20261030", "RRULE:FREQ=WEEKLY", "SUMMARY:a")).master.timeZone, "America/New_York");
	assert.equal(parse(vevent("DTSTART:20261030T140000Z", "SUMMARY:s")).master.timeZone, "America/New_York");
});

test("a declined, skipped or unreadable override still excludes its date from the series", () => {
	const master = ["BEGIN:VEVENT", "UID:u1", "DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY", "SUMMARY:S", "END:VEVENT"];
	const declined = ["BEGIN:VEVENT", "UID:u1", "RECURRENCE-ID:20261104T090000Z", "DTSTART:20261104T110000Z", "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com", "SUMMARY:No", "END:VEVENT"];
	const broken = ["BEGIN:VEVENT", "UID:u1", "RECURRENCE-ID:20261105T090000Z", "DTSTART:nope", "SUMMARY:Broken", "END:VEVENT"];
	const g = parse([...master, ...declined, ...broken].join("\r\n"));
	assert.equal(g.overrides.length, 0);
	assert.equal(g.skipped, 1);
	assert.equal(g.failures.length, 1);
	assert.deepEqual(g.master.excluded.map((d) => d.toISOString()), ["2026-11-04T09:00:00.000Z", "2026-11-05T09:00:00.000Z"]);
	assert.deepEqual(parse([...master, ...declined].join("\r\n"), { skipDeclined: false }).master.excluded.map((d) => d.toISOString()), ["2026-11-04T09:00:00.000Z"]);
});

test("UNTIL and COUNT that are not valid make a single event, never an endless series", () => {
	for (const rule of ["FREQ=DAILY;UNTIL=garbage", "FREQ=DAILY;UNTIL=", "FREQ=DAILY;UNTIL=20261301", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;COUNT=-3", "FREQ=DAILY;COUNT=abc", "FREQ=DAILY;COUNT=999999999", "FREQ=DAILY;COUNT=1.5"]) {
		const g = parse(vevent("DTSTART:20261102T090000Z", `RRULE:${rule}`, "SUMMARY:r"));
		assert.equal(g.master.repeat, "none", rule);
		assert.equal(g.simplified, true, rule);
	}
	for (const rule of ["FREQ=DAILY;UNTIL=20261110", "FREQ=DAILY;UNTIL=20261110T090000Z", "FREQ=DAILY;COUNT=10000"]) {
		assert.equal(parse(vevent("DTSTART:20261102T090000Z", `RRULE:${rule}`, "SUMMARY:r")).master.repeat, "daily", rule);
	}
});

test("a trailing semicolon in an RRULE is tolerated", () => {
	const g = parse(vevent("DTSTART:20261102T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;", "SUMMARY:r"));
	assert.equal(g.master.repeat, "weekly");
	assert.equal(g.simplified, false);
	assert.equal(parse(vevent("DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY;;COUNT=2;", "SUMMARY:r")).master.repeat, "daily");
});

test("every exclusion the group can carry is kept: 1,000 EXDATEs plus 300 cancelled occurrences", () => {
	const day = (n) => new Date(Date.UTC(2027, 0, 1 + n, 9)).toISOString().replace(/[-:]|\.000/g, "");
	const exdates = Array.from({ length: 1000 }, (_, n) => `EXDATE:${day(n)}`);
	const cancelled = Array.from({ length: 300 }, (_, n) => ["BEGIN:VEVENT", "UID:u1", `RECURRENCE-ID:${day(2000 + n)}`, "STATUS:CANCELLED", "END:VEVENT"].join("\r\n"));
	const text = [vevent("DTSTART:20270101T090000Z", "RRULE:FREQ=DAILY", "SUMMARY:e", ...exdates), ...cancelled].join("\r\n");
	const g = parse(text);
	assert.equal(g.master.excluded.length, 1300);
	assert.ok(g.master.excluded.every((date, index, all) => index === 0 || all[index - 1] < date));
});

test("garbage never throws and unreadable events are reported", () => {
	for (const text of ["", "garbage", "BEGIN:VEVENT", "BEGIN:VEVENT\nEND:VEVENT", "\u0000\u0001".repeat(100), "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:nope\r\nEND:VEVENT"]) {
		const g = parse(text);
		assert.equal(g.master, null);
		assert.deepEqual(g.overrides, []);
	}
	assert.equal(parse("BEGIN:VEVENT\r\nUID:x\r\nDTSTART:nope\r\nSUMMARY:Broken\r\nEND:VEVENT").failures.length, 1);
	const nested = parse(vevent("DTSTART:20261104T090000Z", "SUMMARY:n", ...Array.from({ length: 50 }, () => "BEGIN:X-N"), "TRIGGER:-PT5M"));
	assert.ok(nested);
});

test("splitIcsEvents groups VEVENTs by UID and enforces the caps", () => {
	const file = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTIMEZONE", "TZID:X", "END:VTIMEZONE",
		"BEGIN:VEVENT", "UID:a", "DTSTART:20261104T090000Z", "BEGIN:VALARM", "TRIGGER:-PT5M", "END:VALARM", "END:VEVENT",
		"BEGIN:VEVENT", "UID:b", "DTSTART:20261105T090000Z", "END:VEVENT",
		"BEGIN:VEVENT", "UID:a", "RECURRENCE-ID:20261104T090000Z", "DTSTART:20261104T100000Z", "END:VEVENT",
		"BEGIN:VEVENT", "DTSTART:20261105T090000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
	const result = splitIcsEvents(bytes(file));
	assert.equal(result.eventCount, 3);
	assert.equal(result.groups.length, 2);
	assert.equal(result.noUid, 1);
	const a = result.groups.find((group) => group.includes("UID:a"));
	assert.match(a, /RECURRENCE-ID/);
	assert.match(a, /VALARM/);
	assert.doesNotMatch(a, /VTIMEZONE/);
	const capped = splitIcsEvents(bytes(Array.from({ length: 10 }, (_, n) => `BEGIN:VEVENT\r\nUID:e${n}\r\nDTSTART:20261104T090000Z\r\nEND:VEVENT`).join("\r\n")), { maxEvents: 4 });
	assert.equal(capped.groups.length, 4);
	assert.equal(capped.truncated, true);
	const big = splitIcsEvents(bytes(Array.from({ length: 6 }, () => "BEGIN:VEVENT\r\nUID:same\r\nDTSTART:20261104T090000Z\r\nEND:VEVENT").join("\r\n")), { maxGroupEvents: 5 });
	assert.equal(big.groups.length, 0);
	assert.equal(big.tooBig, 1);
});

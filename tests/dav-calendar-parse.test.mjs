import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dav-parse-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: { contents: `export { parseCalendarObject, MAX_VEVENTS } from "./src/lib/dav/calendar-parse.ts"; export { readComponent, unfoldLines } from "./src/lib/dav/content-lines.ts";`, resolveDir: root, sourcefile: "entry.ts" },
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { parseCalendarObject, MAX_VEVENTS, readComponent, unfoldLines } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ics = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\n${events.join("")}END:VCALENDAR\r\n`;
const vevent = (lines) => `BEGIN:VEVENT\r\nUID:u-1\r\nDTSTAMP:20261101T000000Z\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;
const parse = (body, zone = "Europe/Berlin", addresses = ["me@example.test"]) => parseCalendarObject(body, zone, addresses);
const ok = (result) => {
	assert.equal(result.error, undefined, JSON.stringify(result));
	return result;
};

test("a plain UTC event maps its text, times and attendees", () => {
	const { uid, master, overrides } = ok(parse(ics(vevent(["DTSTART:20261102T170000Z", "DTEND:20261102T180000Z", "SUMMARY:Lunch\\, with Ann", "DESCRIPTION:Line one\\nLine two", "LOCATION:Cafe", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:Ann@Example.test", "ATTENDEE:mailto:bob@example.test"]))));
	assert.equal(uid, "u-1");
	assert.deepEqual(overrides, []);
	assert.equal(master.title, "Lunch, with Ann");
	assert.equal(master.description, "Line one\nLine two");
	assert.equal(master.startsAt.toISOString(), "2026-11-02T17:00:00.000Z");
	assert.equal(master.endsAt.toISOString(), "2026-11-02T18:00:00.000Z");
	assert.equal(master.timeZone, null);
	assert.equal(master.allDay, false);
	assert.equal(master.attendees, '["ann@example.test","bob@example.test"]');
	assert.equal(master.attendeeResponses, '{"ann@example.test":"accepted"}');
	assert.deepEqual([master.repeat, master.rrule, master.repeatDays], ["none", null, "[]"]);
});

test("a TZID, a Windows zone name, floating and all-day values are read in the right zone", () => {
	let { master } = ok(parse(ics(vevent(["DTSTART;TZID=America/Los_Angeles:20261102T090000", "DTEND;TZID=America/Los_Angeles:20261102T100000"]))));
	assert.equal(master.startsAt.toISOString(), "2026-11-02T17:00:00.000Z");
	assert.equal(master.timeZone, "America/Los_Angeles");
	({ master } = ok(parse(ics(vevent(["DTSTART;TZID=W. Europe Standard Time:20261102T090000", "DTEND;TZID=W. Europe Standard Time:20261102T100000"])))));
	assert.equal(master.timeZone, "Europe/Berlin");
	({ master } = ok(parse(ics(vevent(["DTSTART:20261102T090000", "DTEND:20261102T100000"])))));
	assert.equal(master.startsAt.toISOString(), "2026-11-02T08:00:00.000Z", "floating times are the user's");
	assert.equal(master.timeZone, "Europe/Berlin");
	({ master } = ok(parse(ics(vevent(["DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103"])))));
	assert.equal(master.allDay, true);
	assert.equal(master.startsAt.toISOString(), "2026-11-01T23:00:00.000Z");
	assert.equal(master.endsAt.toISOString(), "2026-11-02T23:00:00.000Z");
	({ master } = ok(parse(ics(vevent(["DTSTART;VALUE=DATE:20261102"])))));
	assert.equal(master.endsAt.toISOString(), "2026-11-02T23:00:00.000Z", "an all-day event with no end is one day");
});

test("DURATION and a missing end", () => {
	assert.equal(ok(parse(ics(vevent(["DTSTART:20261102T170000Z", "DURATION:PT90M"])))).master.endsAt.toISOString(), "2026-11-02T18:30:00.000Z");
	assert.equal(ok(parse(ics(vevent(["DTSTART:20261102T170000Z"])))).master.endsAt.toISOString(), "2026-11-02T17:00:00.000Z");
	assert.equal(ok(parse(ics(vevent(["DTSTART:20261102T170000Z", "DTEND:20261102T160000Z"])))).master.endsAt.toISOString(), "2026-11-02T17:00:00.000Z", "an end before the start has no length");
});

test("repeat rules: legacy columns when exact, custom when not, one occurrence when the parser cannot read them", () => {
	const repeat = (rule) => ok(parse(ics(vevent(["DTSTART:20261102T170000Z", "DTEND:20261102T180000Z", `RRULE:${rule}`])))).master;
	let m = repeat("FREQ=WEEKLY");
	assert.deepEqual([m.repeat, m.rrule, m.repeatDays, m.repeatUntil], ["weekly", null, "[]", null]);
	m = repeat("FREQ=WEEKLY;BYDAY=MO,WE");
	assert.deepEqual([m.repeat, m.rrule, m.repeatDays], ["weekdays", null, "[1,3]"]);
	m = repeat("FREQ=WEEKLY;INTERVAL=2");
	assert.deepEqual([m.repeat, m.rrule, m.repeatDays, m.repeatAnchorDay, m.repeatUntil], ["custom", "FREQ=WEEKLY;INTERVAL=2", "[]", null, null], "the repeat-fields invariant: custom iff rrule, no legacy columns");
	m = repeat("FREQ=MONTHLY;BYDAY=2TU");
	assert.deepEqual([m.repeat, m.rrule], ["custom", "FREQ=MONTHLY;BYDAY=2TU"]);
	m = repeat("FREQ=DAILY;COUNT=3");
	assert.equal(m.repeat, "daily");
	assert.ok(m.repeatUntil > new Date("2026-11-04T17:00:00Z"));
	assert.equal(m.repeatUntil.getTime() % 1000, 0, "the bound is a whole second, as the column stores it");
	m = repeat("FREQ=DAILY;UNTIL=20261105T170000Z");
	assert.equal(m.repeatUntil.toISOString(), "2026-11-05T17:00:01.000Z", "UNTIL is inclusive: the exclusive bound is just after it");
	m = repeat("FREQ=DAILY;BYHOUR=9");
	assert.deepEqual([m.repeat, m.rrule, m.repeatDays], ["none", null, "[]"]);
	m = repeat("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30");
	assert.equal(m.repeat, "none", "a rule that can never fire is one occurrence");
	m = repeat(`FREQ=WEEKLY;BYDAY=${"MO,".repeat(600)}TU`);
	assert.equal(m.repeat, "none", "an over-long rule is refused by the parser, not expanded");
});

test("EXDATEs are kept (at most 1000) and overrides become rows that the master skips", () => {
	const body = ics(
		vevent(["DTSTART:20261102T170000Z", "DTEND:20261102T180000Z", "RRULE:FREQ=DAILY", "EXDATE:20261103T170000Z,20261104T170000Z", "SUMMARY:Series"]),
		vevent(["RECURRENCE-ID:20261105T170000Z", "DTSTART:20261105T190000Z", "DTEND:20261105T200000Z", "SUMMARY:Moved"]),
		vevent(["RECURRENCE-ID:20261106T170000Z", "DTSTART:20261106T170000Z", "STATUS:CANCELLED"]),
	);
	const { master, overrides } = ok(parse(body));
	assert.equal(overrides.length, 1);
	assert.equal(overrides[0].title, "Moved");
	assert.equal(overrides[0].recurrenceId.toISOString(), "2026-11-05T17:00:00.000Z");
	assert.equal(overrides[0].startsAt.toISOString(), "2026-11-05T19:00:00.000Z");
	assert.deepEqual(master.excludedOccurrences.map((at) => new Date(at).toISOString()).sort(), ["2026-11-03T17:00:00.000Z", "2026-11-04T17:00:00.000Z", "2026-11-05T17:00:00.000Z", "2026-11-06T17:00:00.000Z"]);
	const many = Array.from({ length: 1500 }, (_, i) => `20270101T${String(i % 24).padStart(2, "0")}0000Z`).join(",");
	const capped = ok(parse(ics(vevent(["DTSTART:20261102T170000Z", "RRULE:FREQ=DAILY", `EXDATE:${many}`])))).master;
	assert.ok(capped.excludedOccurrences.length <= 24, "duplicates collapse and the raw values are capped before parsing");
});

test("a resource with only an override builds its master from it", () => {
	const { master, overrides } = ok(parse(ics(vevent(["RECURRENCE-ID:20261105T170000Z", "DTSTART:20261105T190000Z", "DTEND:20261105T200000Z", "SUMMARY:One day"]))));
	assert.deepEqual([master.title, master.repeat, overrides.length, master.excludedOccurrences], ["One day", "none", 0, []]);
});

test("STATUS and the organizer decide the response status; the organizer is kept as the invite sender", () => {
	const status = (lines, addresses) => ok(parse(ics(vevent(["DTSTART:20261102T170000Z", ...lines])), "UTC", addresses)).master;
	assert.equal(status(["STATUS:CANCELLED"]).responseStatus, "cancelled");
	assert.equal(status(["STATUS:TENTATIVE"]).responseStatus, "tentative");
	assert.equal(status(["STATUS:CONFIRMED"]).responseStatus, null);
	const invited = status(["ORGANIZER:mailto:boss@other.test", "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.test"], ["me@example.test"]);
	assert.deepEqual([invited.responseStatus, invited.inviteSender], ["declined", "boss@other.test"]);
	const mine = status(["ORGANIZER:mailto:me@example.test", "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.test"], ["me@example.test"]);
	assert.deepEqual([mine.responseStatus, mine.inviteSender], [null, null], "an event the user organizes is theirs");
});

test("what is refused, with the precondition it violates", () => {
	const error = (body) => parse(body).error;
	assert.equal(error("garbage"), "valid-calendar-object-resource");
	assert.equal(error(ics(vevent(["DTSTART:20261102T170000Z"])).replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:REQUEST")), "valid-calendar-object-resource");
	assert.equal(error(ics("BEGIN:VTODO\r\nUID:u-1\r\nEND:VTODO\r\n")), "supported-calendar-component");
	assert.equal(error(ics("BEGIN:VJOURNAL\r\nUID:u-1\r\nEND:VJOURNAL\r\n")), "supported-calendar-component");
	assert.equal(error(ics(vevent(["SUMMARY:No start"]))), "valid-calendar-object-resource");
	assert.equal(error(ics(vevent(["DTSTART:20261302T170000Z"]))), "valid-calendar-object-resource");
	assert.equal(error(ics(vevent(["DTSTART:30001102T170000Z"]))), "valid-calendar-object-resource", "outside the advertised date range");
	assert.equal(error(ics(vevent(["DTSTART:20261102T170000Z"]), vevent(["DTSTART:20261103T170000Z"]))), "valid-calendar-object-resource", "two masters");
	assert.equal(error(ics(vevent(["DTSTART:20261102T170000Z"]), vevent(["DTSTART:20261103T170000Z", "RECURRENCE-ID:20261103T170000Z"]).replace("UID:u-1", "UID:u-2"))), "valid-calendar-object-resource", "two UIDs");
	assert.equal(error(ics(vevent(["DTSTART:20261102T170000Z"]).replace("UID:u-1\r\n", ""))), "valid-calendar-object-resource", "no UID");
	assert.equal(error(ics(vevent(["DTSTART:20261102T170000Z"]).replace("UID:u-1", `UID:${"x".repeat(192)}`))), "valid-calendar-object-resource", "a UID the MySQL index cannot hold");
	assert.equal(parse(ics(vevent(["DTSTART:20261102T170000Z"]).replace("UID:u-1", `UID:${"x".repeat(191)}`))).error, undefined);
	const twice = vevent(["RECURRENCE-ID:20261105T170000Z", "DTSTART:20261105T190000Z"]);
	assert.equal(error(ics(vevent(["DTSTART:20261102T170000Z", "RRULE:FREQ=DAILY"]), twice, twice)), "valid-calendar-object-resource", "two overrides of one occurrence");
	const many = Array.from({ length: MAX_VEVENTS + 1 }, (_, i) => vevent(["DTSTART:20261102T170000Z", `RECURRENCE-ID:2027${String(1 + (i % 12)).padStart(2, "0")}${String(1 + Math.floor(i / 12)).padStart(2, "0")}T170000Z`]));
	assert.equal(error(ics(...many)), "max-instances");
	assert.equal(parse(ics(...many.slice(0, MAX_VEVENTS))).error, undefined);
});

test("VTIMEZONE, ATTACH, URL and a second VALARM are ignored and nothing is fetched", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = () => {
		throw new Error("the parser must not fetch");
	};
	try {
		const body = ics(
			"BEGIN:VTIMEZONE\r\nTZID:Custom\r\nTZURL:http://tz.invalid/zone\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n",
			vevent(["DTSTART:20261102T170000Z", "ATTACH;VALUE=URI:http://attach.invalid/a.pdf", "URL:http://url.invalid/", "CONFERENCE;VALUE=URI:http://meet.invalid/x", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", "DESCRIPTION:x", "END:VALARM", "BEGIN:VALARM", "ACTION:AUDIO", "TRIGGER:-PT1H", "END:VALARM"]),
		);
		const result = ok(parse(body));
		assert.equal("reminderMinutes" in result.master, false, "alarms never set a Mailflare reminder");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("the reader is bounded: depth, property count, parameter size, unbalanced and trailing input", () => {
	assert.equal(readComponent(`BEGIN:VCALENDAR\r\n${"BEGIN:X\r\n".repeat(9)}${"END:X\r\n".repeat(9)}END:VCALENDAR\r\n`, "VCALENDAR"), null);
	assert.ok(readComponent(`BEGIN:VCALENDAR\r\n${"BEGIN:X\r\n".repeat(7)}${"END:X\r\n".repeat(7)}END:VCALENDAR\r\n`, "VCALENDAR"));
	assert.equal(readComponent(`BEGIN:VCALENDAR\r\n${"X-A:1\r\n".repeat(20_001)}END:VCALENDAR\r\n`, "VCALENDAR"), null);
	assert.equal(readComponent(`BEGIN:VCALENDAR\r\nX-A;P=${"y".repeat(4097)}:1\r\nEND:VCALENDAR\r\n`, "VCALENDAR"), null);
	assert.equal(readComponent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n", "VCALENDAR"), null);
	assert.equal(readComponent("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "VCALENDAR"), null);
	assert.equal(readComponent("BEGIN:VCARD\r\nEND:VCARD\r\n", "VCALENDAR"), null);
	assert.equal(readComponent("END:VCALENDAR\r\n", "VCALENDAR"), null);
});

test("unfolding is linear on adversarial input and handles every line ending", () => {
	assert.deepEqual(unfoldLines("A:1\r\n 2\r\n\t3\nB:x\rC"), ["A:123", "B:x\rC"]);
	const started = performance.now();
	unfoldLines(`A:${"x".repeat(900_000)}\r\n${" \r\n".repeat(50_000)}`);
	unfoldLines("\n \n".repeat(50_000));
	readComponent(`BEGIN:VCALENDAR\r\nX-A;${"P=\";".repeat(200_000)}:1\r\nEND:VCALENDAR\r\n`, "VCALENDAR");
	assert.ok(performance.now() - started < 1500, `took ${performance.now() - started}ms`);
});

test("rejects malformed addresses", () => {
	const long = `${"a".repeat(307)}@example.test`;
	const tooLong = `${"a".repeat(320)}@example.test`;
	const bad = ["a@b@example.test", "@example.test", "a@", "a b@example.test", "a,b@example.test", "a;b@example.test", "<a@example.test>", "a:b@example.test", 'a"b@example.test', "a\u0001b@example.test", "no-at-sign"];
	const body = ics(vevent(["DTSTART:20261102T170000Z", "ORGANIZER:mailto:" + tooLong, `ATTENDEE:mailto:${tooLong}`, `ATTENDEE:mailto:${long}`, ...bad.map((address) => `ATTENDEE:mailto:${address}`), "ATTENDEE:mailto:ok@example.test"]));
	const { master } = ok(parse(body));
	assert.deepEqual(JSON.parse(master.attendees), [long, "ok@example.test"], "320 characters is the cap; one plain address is the shape");
	assert.equal(master.inviteSender, null, "an oversized organizer is not an address");
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-calendar-invite-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { i: join(root, "src/lib/calendar/invite.ts"), r: join(root, "src/lib/calendar/invite-rules.ts"), u: join(root, "src/lib/calendar/utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { parseInvite, inviteRepeat, buildReplyIcs, parseIcsDuration, WINDOWS_TIME_ZONES } = await import(pathToFileURL(join(dir, "i.mjs")).href);
const { planInboundInvite, planInviteAnswer, inviteSenderMatches, addExcludedOccurrence, mergeExcludedOccurrences, normalizeInviteSender, chooseRecipientZone, inboundNeedsRecipientZone } = await import(pathToFileURL(join(dir, "r.mjs")).href);
const { createCalendarInvitation } = await import(pathToFileURL(join(dir, "u.mjs")).href);

const ics = (...lines) => lines.join("\r\n");
const event = (...lines) => ics("BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:x", ...lines, "END:VEVENT", "END:VCALENDAR");

const mailflare = ics("BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:evt_abc@mailflare", "DTSTART:20261104T170000Z", "DTEND:20261104T180000Z", "SUMMARY:Planning meeting\\, Q4", "DESCRIPTION:Line one\\nLine two", "LOCATION:", "END:VEVENT", "END:VCALENDAR");

test("parses a Mailflare invite", () => {
	const invite = parseInvite(mailflare);
	assert.equal(invite.uid, "evt_abc@mailflare");
	assert.equal(invite.method, "REQUEST");
	assert.equal(invite.title, "Planning meeting, Q4");
	assert.equal(invite.description, "Line one\nLine two");
	assert.equal(invite.startsAt.toISOString(), "2026-11-04T17:00:00.000Z");
	assert.equal(invite.organizer, null);
	assert.equal(invite.sequence, 0);
	assert.equal(invite.recurrenceId, null);
});

test("converts a TZID start to UTC across daylight saving", () => {
	const text = ics("BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "DTSTART;TZID=America/Vancouver:20261102T090000", "DURATION:PT30M", "ORGANIZER;CN=Organizer:mailto:organizer@example.com", "SUMMARY:Sync", "END:VEVENT", "END:VCALENDAR");
	const invite = parseInvite(text);
	assert.equal(invite.startsAt.toISOString(), "2026-11-02T17:00:00.000Z");
	assert.equal(invite.endsAt.toISOString(), "2026-11-02T17:30:00.000Z");
	assert.equal(invite.organizer, "organizer@example.com");
	assert.equal(invite.timeZone, "America/Vancouver");
});

test("reads an Outlook invitation with a Windows zone name and a VTIMEZONE block", () => {
	const outlook = ics("BEGIN:VCALENDAR", "METHOD:REQUEST", "PRODID:Microsoft Exchange Server 2010", "VERSION:2.0",
		"BEGIN:VTIMEZONE", "TZID:Pacific Standard Time",
		"BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11", "END:STANDARD",
		"BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3", "END:DAYLIGHT",
		"END:VTIMEZONE",
		"BEGIN:VEVENT", "ORGANIZER;CN=Organizer:mailto:organizer@example.com", "SUMMARY;LANGUAGE=en-US:Budget review",
		"DTSTART;TZID=Pacific Standard Time:20261110T100000", "DTEND;TZID=Pacific Standard Time:20261110T110000",
		"UID:040000008200E00074C5B7101A82E008", "SEQUENCE:2", "END:VEVENT", "END:VCALENDAR");
	const invite = parseInvite(outlook, { timeZone: "Europe/Paris" });
	assert.equal(invite.startsAt.toISOString(), "2026-11-10T18:00:00.000Z");
	assert.equal(invite.endsAt.toISOString(), "2026-11-10T19:00:00.000Z");
	assert.equal(invite.timeZone, "America/Los_Angeles");
	assert.equal(invite.sequence, 2);
	assert.equal(invite.title, "Budget review");
});

test("every Windows zone in the table is known to Intl", () => {
	for (const [windows, iana] of Object.entries(WINDOWS_TIME_ZONES)) assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: iana }), windows);
	for (const name of ["Pacific Standard Time", "Mountain Standard Time", "US Mountain Standard Time", "Central Standard Time", "Eastern Standard Time", "Atlantic Standard Time", "Newfoundland Standard Time", "Alaskan Standard Time", "Hawaiian Standard Time", "Canada Central Standard Time", "UTC", "GMT Standard Time", "W. Europe Standard Time", "Central Europe Standard Time", "Central European Standard Time", "Romance Standard Time", "E. Europe Standard Time", "Russian Standard Time", "Israel Standard Time", "Arab Standard Time", "India Standard Time", "China Standard Time", "Tokyo Standard Time", "Korea Standard Time", "AUS Eastern Standard Time", "New Zealand Standard Time"]) assert.ok(WINDOWS_TIME_ZONES[name], name);
});

test("floating times and unknown zones are read in the recipient's zone, not UTC", () => {
	const floating = parseInvite(event("DTSTART:20261110T100000", "DTEND:20261110T110000"), { timeZone: "America/Vancouver" });
	assert.equal(floating.startsAt.toISOString(), "2026-11-10T18:00:00.000Z");
	assert.equal(floating.timeZone, null);
	const unknown = parseInvite(event("DTSTART;TZID=Somewhere Odd:20261110T100000", "DTEND;TZID=Somewhere Odd:20261110T110000"), { timeZone: "America/Vancouver" });
	assert.equal(unknown.startsAt.toISOString(), "2026-11-10T18:00:00.000Z");
	assert.equal(unknown.endsAt.toISOString(), "2026-11-10T19:00:00.000Z");
	assert.equal(parseInvite(event("DTSTART:20261110T100000")).startsAt.toISOString(), "2026-11-10T10:00:00.000Z");
});

test("an all-day event covers the whole local day", () => {
	const withEnd = parseInvite(event("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106"), { timeZone: "America/Vancouver" });
	assert.equal(withEnd.allDay, true);
	assert.equal(withEnd.startsAt.toISOString(), "2026-11-05T08:00:00.000Z");
	assert.equal(withEnd.endsAt.toISOString(), "2026-11-06T08:00:00.000Z");
	const noEnd = parseInvite(event("DTSTART;VALUE=DATE:20261105"), { timeZone: "America/Vancouver" });
	assert.equal(noEnd.endsAt.toISOString(), "2026-11-06T08:00:00.000Z");
	// The day daylight saving ends is 25 hours long; the end is still the next local midnight.
	const dstDay = parseInvite(event("DTSTART;VALUE=DATE:20261101"), { timeZone: "America/Vancouver" });
	assert.equal(dstDay.startsAt.toISOString(), "2026-11-01T07:00:00.000Z");
	assert.equal(dstDay.endsAt.toISOString(), "2026-11-02T08:00:00.000Z");
	const multi = parseInvite(event("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261108"), { timeZone: "America/Vancouver" });
	assert.equal(multi.endsAt.toISOString(), "2026-11-08T08:00:00.000Z");
});

test("reads RECURRENCE-ID with the same zone rules", () => {
	const cancel = ics("BEGIN:VCALENDAR", "METHOD:CANCEL", "BEGIN:VEVENT", "UID:series-1", "RECURRENCE-ID;TZID=Pacific Standard Time:20261117T100000", "DTSTART;TZID=Pacific Standard Time:20261117T100000", "DTEND;TZID=Pacific Standard Time:20261117T110000", "SEQUENCE:3", "SUMMARY:Weekly", "END:VEVENT", "END:VCALENDAR");
	const invite = parseInvite(cancel, { timeZone: "UTC" });
	assert.equal(invite.method, "CANCEL");
	assert.equal(invite.recurrenceId.toISOString(), "2026-11-17T18:00:00.000Z");
	const utc = parseInvite(event("DTSTART:20261117T180000Z", "RECURRENCE-ID:20261117T180000Z"));
	assert.equal(utc.recurrenceId.toISOString(), "2026-11-17T18:00:00.000Z");
	const floating = parseInvite(event("DTSTART:20261117T100000", "RECURRENCE-ID:20261117T100000"), { timeZone: "America/Vancouver" });
	assert.equal(floating.recurrenceId.toISOString(), "2026-11-17T18:00:00.000Z");
});

test("a file with the series and a changed occurrence is read as the series", () => {
	const text = ics("BEGIN:VCALENDAR", "METHOD:REQUEST",
		"BEGIN:VEVENT", "UID:s", "RECURRENCE-ID:20261117T180000Z", "DTSTART:20261117T190000Z", "SUMMARY:Moved", "END:VEVENT",
		"BEGIN:VEVENT", "UID:s", "DTSTART:20261110T180000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20261124T180000Z,20261201T180000Z", "SUMMARY:Series", "END:VEVENT", "END:VCALENDAR");
	const invite = parseInvite(text);
	assert.equal(invite.title, "Series");
	assert.equal(invite.recurrenceId, null);
	assert.deepEqual(invite.excludedDates.map((date) => date.toISOString()), ["2026-11-24T18:00:00.000Z", "2026-12-01T18:00:00.000Z"]);
});

test("a cancel or decline of one occurrence excludes it and never deletes the series", () => {
	const occurrence = new Date("2026-11-17T18:00:00.000Z");
	assert.deepEqual(planInboundInvite({ method: "CANCEL", recurrenceId: occurrence, sequence: 3 }, { inviteSequence: 1 }), { action: "exclude", occurrence });
	assert.equal(planInboundInvite({ method: "CANCEL", recurrenceId: null, sequence: 3 }, { inviteSequence: 1 }).action, "delete");
	assert.equal(planInboundInvite({ method: "CANCEL", recurrenceId: occurrence, sequence: 3 }, null).action, "ignore");
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: occurrence, sequence: 3 }, { inviteSequence: 1 }).action, "ignore");
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: occurrence, sequence: 3 }, null).action, "ignore");
	assert.deepEqual(planInviteAnswer({ method: "REQUEST", recurrenceId: occurrence, sequence: 0 }, "declined", { inviteSequence: 0 }), { action: "exclude", occurrence });
	assert.equal(planInviteAnswer({ method: "CANCEL", recurrenceId: occurrence, sequence: 0 }, "declined", { inviteSequence: 0 }).action, "exclude");
	assert.equal(planInviteAnswer({ method: "REQUEST", recurrenceId: occurrence, sequence: 0 }, "accepted", { inviteSequence: 0 }).action, "none");
	assert.equal(planInviteAnswer({ method: "REQUEST", recurrenceId: occurrence, sequence: 0 }, "tentative", null).action, "none");
	assert.equal(planInviteAnswer({ method: "REQUEST", recurrenceId: null, sequence: 0 }, "declined", { inviteSequence: 0 }).action, "delete");
	assert.equal(addExcludedOccurrence("[1000]", occurrence), JSON.stringify([1000, occurrence.getTime()]));
	assert.equal(addExcludedOccurrence(JSON.stringify([occurrence.getTime()]), occurrence), JSON.stringify([occurrence.getTime()]));
	assert.equal(addExcludedOccurrence("not json", occurrence), JSON.stringify([occurrence.getTime()]));
	assert.equal(mergeExcludedOccurrences("[5000]", [new Date(2000)]), "[2000,5000]");
});

test("SEQUENCE keeps an older revision from overwriting a newer one", () => {
	assert.equal(parseInvite(event("DTSTART:20261110T100000Z", "SEQUENCE:4")).sequence, 4);
	assert.equal(parseInvite(event("DTSTART:20261110T100000Z", "SEQUENCE:junk")).sequence, 0);
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: null, sequence: 1 }, { inviteSequence: 2 }).action, "ignore");
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: null, sequence: 2 }, { inviteSequence: 2 }).action, "update");
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: null, sequence: 3 }, { inviteSequence: 2 }).action, "update");
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: null, sequence: 0 }, { inviteSequence: null }).action, "update");
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: null, sequence: 0 }, null).action, "insert");
	assert.equal(planInviteAnswer({ method: "REQUEST", recurrenceId: null, sequence: 1 }, "accepted", { inviteSequence: 2 }).action, "status");
	assert.equal(planInviteAnswer({ method: "REQUEST", recurrenceId: null, sequence: 2 }, "accepted", { inviteSequence: 2 }).action, "upsert");
	assert.equal(planInviteAnswer({ method: "REQUEST", recurrenceId: null, sequence: 0 }, "tentative", null).action, "upsert");
});

test("the stored sender decides, so deleting the original email does not orphan the event", () => {
	assert.equal(normalizeInviteSender("Organizer <Organizer@Example.com>"), "organizer@example.com");
	assert.equal(inviteSenderMatches({ inviteSender: "organizer@example.com" }, "ORGANIZER@example.com"), true);
	assert.equal(inviteSenderMatches({ inviteSender: "organizer@example.com" }, "Someone <other@example.com>"), false);
	// A row without a stored sender fails closed.
	assert.equal(inviteSenderMatches({ inviteSender: null }, "organizer@example.com"), false);
	assert.equal(inviteSenderMatches({}, "organizer@example.com"), false);
	assert.equal(inviteSenderMatches({ inviteSender: "organizer@example.com" }, ""), false);
});

test("unfolds long lines and rejects files without a start", () => {
	assert.equal(parseInvite(ics("BEGIN:VEVENT", "UID:x", "SUMMARY:No start", "END:VEVENT")), null);
	const folded = ics("BEGIN:VEVENT", "UID:x", "DTSTART:20261104T170000Z", "SUMMARY:Very long", " title", "END:VEVENT");
	assert.equal(parseInvite(folded).title, "Very longtitle");
});

test("properties of a nested VALARM are not read as the event's", () => {
	const text = event("DTSTART:20261104T170000Z", "SUMMARY:Event title",
		"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M", "ATTENDEE:mailto:alarm@example.com", "END:VALARM",
		"ATTENDEE;PARTSTAT=ACCEPTED:mailto:guest@example.com");
	const invite = parseInvite(text);
	assert.equal(invite.description, "");
	assert.equal(invite.title, "Event title");
	assert.deepEqual(invite.attendees, [{ email: "guest@example.com", status: "ACCEPTED" }]);
});

test("a colon inside a quoted parameter does not end the property name", () => {
	const invite = parseInvite(event("DTSTART:20261104T170000Z", "ORGANIZER;CN=\"Doe: J\":mailto:doe@example.com", "ATTENDEE;CN=\"Smith; A: B\";PARTSTAT=TENTATIVE:mailto:smith@example.com"));
	assert.equal(invite.organizer, "doe@example.com");
	assert.deepEqual(invite.attendees, [{ email: "smith@example.com", status: "TENTATIVE" }]);
});

test("DURATION accepts weeks, days, hours, minutes and seconds", () => {
	assert.deepEqual(parseIcsDuration("P1W"), { days: 7, ms: 0 });
	assert.deepEqual(parseIcsDuration("PT90M"), { days: 0, ms: 90 * 60_000 });
	assert.deepEqual(parseIcsDuration("PT1H30M"), { days: 0, ms: 90 * 60_000 });
	assert.deepEqual(parseIcsDuration("P1DT2H"), { days: 1, ms: 2 * 3_600_000 });
	assert.deepEqual(parseIcsDuration("PT45S"), { days: 0, ms: 45_000 });
	assert.equal(parseIcsDuration("-PT15M"), null);
	assert.equal(parseIcsDuration("bogus"), null);
	const start = "DTSTART:20261104T170000Z";
	assert.equal(parseInvite(event(start, "DURATION:PT90M")).endsAt.toISOString(), "2026-11-04T18:30:00.000Z");
	assert.equal(parseInvite(event(start, "DURATION:P1DT2H")).endsAt.toISOString(), "2026-11-05T19:00:00.000Z");
	assert.equal(parseInvite(event(start, "DURATION:P1W")).endsAt.toISOString(), "2026-11-11T17:00:00.000Z");
	assert.equal(parseInvite(event(start, "DURATION:PT45S")).endsAt.toISOString(), "2026-11-04T17:00:45.000Z");
});

test("maps simple recurrence rules and drops unsupported ones", () => {
	assert.equal(inviteRepeat("FREQ=DAILY").repeat, "daily");
	assert.deepEqual(inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE").repeatDays, [1, 3]);
	assert.equal(inviteRepeat("FREQ=WEEKLY;INTERVAL=2").repeat, "none");
	assert.equal(inviteRepeat("FREQ=MONTHLY;BYMONTHDAY=15").repeatAnchorDay, 15);
	assert.equal(inviteRepeat(null).repeat, "none");
	assert.equal(inviteRepeat("FREQ=WEEKLY").repeatUntil, null);
});

test("COUNT becomes an end that still includes the last occurrence", () => {
	const zone = "America/Vancouver";
	// Tuesday 2026-11-03 10:00 PST.
	const start = new Date("2026-11-03T18:00:00.000Z");
	const until = (rule, at = start) => inviteRepeat(rule, at, zone).repeatUntil?.toISOString();
	assert.equal(until("FREQ=DAILY;COUNT=3"), "2026-11-05T18:00:01.000Z");
	assert.equal(until("FREQ=WEEKLY;COUNT=4"), "2026-11-24T18:00:01.000Z");
	assert.equal(until("FREQ=WEEKLY;COUNT=1"), "2026-11-03T18:00:01.000Z");
	// Tue, Thu, Tue, Thu, Tue: the fifth is Tuesday 2026-11-17.
	const weekdays = inviteRepeat("FREQ=WEEKLY;BYDAY=TU,TH;COUNT=5", start, zone);
	assert.equal(weekdays.repeat, "weekdays");
	assert.equal(weekdays.repeatUntil.toISOString(), "2026-11-17T18:00:01.000Z");
	assert.equal(until("FREQ=MONTHLY;COUNT=3"), "2027-01-03T18:00:01.000Z");
	// Monthly on the 31st clamps to the end of shorter months, like the calendar.
	assert.equal(until("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=2", new Date("2027-01-31T18:00:00.000Z")), "2027-02-28T18:00:01.000Z");
	// The wall clock is kept across a daylight saving change: 10:00 PDT on Oct 27 to 10:00 PST on Nov 3.
	assert.equal(until("FREQ=WEEKLY;COUNT=2", new Date("2026-10-27T17:00:00.000Z")), "2026-11-03T18:00:01.000Z");
	assert.equal(inviteRepeat("FREQ=WEEKLY;COUNT=4").repeatUntil, null);
	assert.equal(inviteRepeat("FREQ=WEEKLY;COUNT=0", start, zone).repeatUntil, null);
});

test("UNTIL includes an occurrence that starts exactly then", () => {
	assert.equal(inviteRepeat("FREQ=WEEKLY;UNTIL=20261124T180000Z").repeatUntil.toISOString(), "2026-11-24T18:00:01.000Z");
	assert.equal(inviteRepeat("FREQ=DAILY;UNTIL=20261124", undefined, "America/Vancouver").repeatUntil.toISOString(), "2026-11-25T08:00:00.000Z");
});

test("reply carries the attendee status, sequence and occurrence, folded with a trailing CRLF", () => {
	const reply = buildReplyIcs(parseInvite(mailflare), "guest@example.com", "tentative");
	assert.match(reply, /METHOD:REPLY/);
	assert.match(reply, /ATTENDEE;PARTSTAT=TENTATIVE:mailto:guest@example.com/);
	assert.match(reply, /\r\nSEQUENCE:0\r\n/);
	assert.doesNotMatch(reply, /RECURRENCE-ID/);
	assert.ok(reply.endsWith("END:VCALENDAR\r\n"));
	const occurrence = parseInvite(event("DTSTART:20261117T180000Z", "RECURRENCE-ID:20261117T180000Z", "SEQUENCE:5", `SUMMARY:${"Long title ".repeat(12)}`));
	const occurrenceReply = buildReplyIcs(occurrence, "guest@example.com", "declined");
	assert.match(occurrenceReply, /\r\nRECURRENCE-ID:20261117T180000Z\r\n/);
	assert.match(occurrenceReply, /\r\nSEQUENCE:5\r\n/);
	for (const line of occurrenceReply.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
	assert.equal(parseInvite(occurrenceReply).title, "Long title ".repeat(12).trim());
});

test("a reply built by Mailflare parses back to the answering guest and status", () => {
	const reply = buildReplyIcs(parseInvite(mailflare), "guest@example.com", "accepted");
	const parsed = parseInvite(reply);
	assert.equal(parsed.method, "REPLY");
	assert.equal(parsed.uid, "evt_abc@mailflare");
	assert.deepEqual(parsed.attendees, [{ email: "guest@example.com", status: "ACCEPTED" }]);
});

test("outgoing invitations fold long lines and end with CRLF", () => {
	const text = new TextDecoder().decode(createCalendarInvitation({ title: "T", description: "word ".repeat(40), location: "", startsAt: new Date("2026-11-04T17:00:00Z"), endsAt: new Date("2026-11-04T18:00:00Z"), uid: "evt_1", organizer: "me@example.com", attendees: ["guest@example.com"] }));
	assert.ok(text.endsWith("END:VCALENDAR\r\n"));
	for (const line of text.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
	const parsed = parseInvite(text);
	assert.equal(parsed.description, "word ".repeat(40).trim());
	assert.equal(parsed.organizer, "me@example.com");
});

test("sender-controlled size is bounded: EXDATE list and RRULE COUNT", () => {
	const dates = Array.from({ length: 5000 }, (_, i) => `2027${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T100000Z`).join(",");
	const started = Date.now();
	const invite = parseInvite(event("DTSTART:20261105T170000Z", "DTEND:20261105T180000Z", "RRULE:FREQ=WEEKLY", `EXDATE:${dates}`));
	assert.ok(invite.excludedDates.length <= 1000);
	assert.ok(JSON.parse(mergeExcludedOccurrences("[]", invite.excludedDates)).length <= 1000);
	// A COUNT reaching past about 200 years becomes a single event, never an endless series.
	const huge = inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=1000000", new Date("2026-11-02T17:00:00Z"), "America/Vancouver");
	assert.equal(huge.repeat, "none");
	assert.equal(huge.repeatUntil, null);
	const ok = inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=1000", new Date("2026-11-02T17:00:00Z"), "America/Vancouver");
	assert.ok(ok.repeatUntil instanceof Date);
	assert.ok(Date.now() - started < 5000, "bounded work");
});

test("hostile durations and dates never throw", () => {
	const start = "DTSTART:20261104T170000Z";
	for (const duration of ["P99999999999D", "P99999999999W", "PT99999999999H", "PT99999999999999999999S", "P367D"]) {
		const invite = parseInvite(event(start, `DURATION:${duration}`));
		// Over-long durations are ignored, so the default hour applies.
		assert.equal(invite.endsAt.toISOString(), "2026-11-04T18:00:00.000Z", duration);
	}
	assert.equal(parseIcsDuration("P366D").days, 366);
	assert.equal(parseIcsDuration("P99999999999D"), null);
	assert.doesNotThrow(() => parseInvite(event("DTSTART;VALUE=DATE:99991231", "DURATION:P366D")));
	assert.doesNotThrow(() => parseInvite(event("DTSTART:99991231T235959Z", "DURATION:P366D")));
	assert.equal(parseInvite(event(start, "RECURRENCE-ID:garbage")), null);
	assert.equal(parseInvite(event(start, "RECURRENCE-ID:20261345T100000Z")), null);
});

test("impossible dates are rejected instead of rolling over", () => {
	assert.equal(parseInvite(event("DTSTART;VALUE=DATE:20261345")), null);
	assert.equal(parseInvite(event("DTSTART:20260230T100000Z")), null);
	assert.equal(parseInvite(event("DTSTART:20261104T250000Z")), null);
	assert.equal(parseInvite(event("DTSTART:20261104T106000")), null);
	// A bad DTEND falls back to the default length instead of a rolled-over date.
	assert.equal(parseInvite(event("DTSTART:20261104T170000Z", "DTEND:20261332T170000Z")).endsAt.toISOString(), "2026-11-04T18:00:00.000Z");
	assert.equal(parseInvite(event("DTSTART;VALUE=DATE:20240229")).allDay, true);
});

test("EXDATE values are capped before they are parsed", () => {
	const values = Array.from({ length: 15_000 }, (_, i) => `2027${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T100000`).join(",");
	const text = event("DTSTART;TZID=America/Vancouver:20261105T100000", "RRULE:FREQ=DAILY", `EXDATE;TZID=America/Vancouver:${values}`, `EXDATE;TZID=Pacific Standard Time:${values}`);
	parseInvite(text);
	const started = performance.now();
	const invite = parseInvite(text);
	const elapsed = performance.now() - started;
	assert.equal(invite.excludedDates.length, 1000);
	assert.ok(elapsed < 100, `took ${elapsed} ms`);
});

test("COUNT of any size gives a finite end or a single event, quickly", () => {
	const zone = "America/Vancouver";
	const start = new Date("2026-11-03T18:00:00.000Z");
	const daily1001 = inviteRepeat("FREQ=DAILY;COUNT=1001", start, zone);
	assert.equal(daily1001.repeat, "daily");
	assert.equal(daily1001.repeatUntil.toISOString(), "2029-07-30T17:00:01.000Z");
	const started = performance.now();
	for (const rule of ["FREQ=DAILY;COUNT=1000000", "FREQ=WEEKLY;COUNT=1000000", "FREQ=MONTHLY;COUNT=1000000", "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=1000000", "FREQ=DAILY;COUNT=99999999999999999999"]) {
		const repeat = inviteRepeat(rule, start, zone);
		assert.ok(repeat.repeat === "none" || Number.isFinite(repeat.repeatUntil?.getTime()), rule);
		assert.equal(repeat.repeat, "none", rule);
	}
	assert.ok(performance.now() - started < 100);
	// Large but sane counts are computed directly rather than walked.
	const weekly5000 = inviteRepeat("FREQ=WEEKLY;COUNT=5000", start, zone);
	assert.equal(weekly5000.repeat, "weekly");
	assert.ok(Number.isFinite(weekly5000.repeatUntil.getTime()));
	// Tue and Thu: occurrence 2001 is week 1000 (Tuesday), 7000 days after the start.
	const weekdays = inviteRepeat("FREQ=WEEKLY;BYDAY=TU,TH;COUNT=2001", start, zone);
	const expected = new Date(Date.UTC(2026, 10, 3) + 7000 * 86_400_000);
	assert.equal(weekdays.repeatUntil.toISOString().slice(0, 10), expected.toISOString().slice(0, 10));
	assert.equal(inviteRepeat("FREQ=DAILY;COUNT=0", start, zone).repeat, "none");
	assert.equal(inviteRepeat("FREQ=DAILY;COUNT=abc", start, zone).repeat, "none");
});

test("FREQ=DAILY with BYDAY is the weekdays repeat", () => {
	const repeat = inviteRepeat("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR");
	assert.equal(repeat.repeat, "weekdays");
	assert.deepEqual(repeat.repeatDays, [1, 2, 3, 4, 5]);
	// Mon 2026-11-02 start, 5 weekday occurrences: the last is Fri 2026-11-06.
	const counted = inviteRepeat("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=6", new Date("2026-11-02T18:00:00.000Z"), "America/Vancouver");
	assert.equal(counted.repeatUntil.toISOString(), "2026-11-09T18:00:01.000Z");
});

test("one recipient zone: the account's, else the latest event's, else unknown", () => {
	assert.equal(chooseRecipientZone("America/Vancouver", "Europe/Paris"), "America/Vancouver");
	assert.equal(chooseRecipientZone(null, "Europe/Paris"), "Europe/Paris");
	assert.equal(chooseRecipientZone("Not/AZone", "Europe/Paris"), "Europe/Paris");
	assert.equal(chooseRecipientZone("", null), null);
	assert.equal(chooseRecipientZone(null, "nonsense"), null);
	const allDay = parseInvite(event("DTSTART;VALUE=DATE:20261105"));
	const floating = parseInvite(event("DTSTART:20261105T100000"));
	const unknownZone = parseInvite(event("DTSTART;TZID=Somewhere Odd:20261105T100000"));
	const utc = parseInvite(event("DTSTART:20261105T100000Z", "DTEND:20261105T110000Z"));
	const zoned = parseInvite(event("DTSTART;TZID=Pacific Standard Time:20261105T100000", "DTEND;TZID=Pacific Standard Time:20261105T110000"));
	assert.equal(allDay.usedFallbackZone, true);
	assert.equal(floating.usedFallbackZone, true);
	assert.equal(unknownZone.usedFallbackZone, true);
	assert.equal(utc.usedFallbackZone, false);
	assert.equal(zoned.usedFallbackZone, false);
	assert.equal(inboundNeedsRecipientZone(allDay), true);
	assert.equal(inboundNeedsRecipientZone(floating), true);
	assert.equal(inboundNeedsRecipientZone(utc), false);
	assert.equal(inboundNeedsRecipientZone(zoned), false);
	// Cancelling a whole series or recording a reply uses no times.
	assert.equal(inboundNeedsRecipientZone({ method: "CANCEL", recurrenceId: null, usedFallbackZone: true }), false);
	assert.equal(inboundNeedsRecipientZone({ method: "CANCEL", recurrenceId: new Date(), usedFallbackZone: true }), true);
	assert.equal(inboundNeedsRecipientZone({ method: "REPLY", recurrenceId: null, usedFallbackZone: true }), false);
	assert.equal(parseInvite(event("DTSTART:20261105T100000Z", "EXDATE:20261112T100000")).usedFallbackZone, true);
});

test("an all-day reply writes DTSTART and RECURRENCE-ID as dates in the recipient's zone", () => {
	const invite = parseInvite(event("DTSTART;VALUE=DATE:20261105", "RECURRENCE-ID;VALUE=DATE:20261105", "SEQUENCE:1"), { timeZone: "America/Vancouver" });
	assert.equal(invite.recurrenceId.toISOString(), "2026-11-05T08:00:00.000Z");
	const reply = buildReplyIcs(invite, "guest@example.com", "declined");
	assert.match(reply, /\r\nDTSTART;VALUE=DATE:20261105\r\n/);
	assert.match(reply, /\r\nRECURRENCE-ID;VALUE=DATE:20261105\r\n/);
	const back = parseInvite(reply, { timeZone: "America/Vancouver" });
	assert.equal(back.recurrenceId.toISOString(), invite.recurrenceId.toISOString());
	// Timed occurrences keep UTC date-times.
	assert.match(buildReplyIcs(parseInvite(event("DTSTART:20261117T180000Z", "RECURRENCE-ID:20261117T180000Z")), "guest@example.com", "accepted"), /\r\nRECURRENCE-ID:20261117T180000Z\r\n/);
});

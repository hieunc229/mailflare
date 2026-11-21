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
	entryPoints: { d: join(root, "src/lib/calendar/invite-delivery.ts"), i: join(root, "src/lib/calendar/invite.ts"), r: join(root, "src/lib/calendar/invite-rules.ts"), u: join(root, "src/lib/calendar/utils.ts"), t: join(root, "src/lib/calendar/tool-occurrences.ts"), s: join(root, "src/lib/calendar/split-announcement.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { parseInvite, inviteRepeat, buildReplyIcs, buildReplyText, buildCounterIcs, parseCounterProposal, parseIcsDuration, WINDOWS_TIME_ZONES, inviteAttendeeAddresses, parseAlarmTrigger } = await import(pathToFileURL(join(dir, "i.mjs")).href);
const { expandToolEvents } = await import(pathToFileURL(join(dir, "t.mjs")).href);
const { planInboundInvite, planInviteAnswer, inviteSenderMatches, addExcludedOccurrence, mergeExcludedOccurrences, normalizeInviteSender, chooseRecipientZone, inboundNeedsRecipientZone } = await import(pathToFileURL(join(dir, "r.mjs")).href);
const { createCalendarInvitation } = await import(pathToFileURL(join(dir, "u.mjs")).href);
const { sendToAttendees } = await import(pathToFileURL(join(dir, "d.mjs")).href);
const { buildSplitAnnouncement } = await import(pathToFileURL(join(dir, "s.mjs")).href);

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
	const text = ics("BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "DTSTART;TZID=America/Los_Angeles:20261102T090000", "DURATION:PT30M", "ORGANIZER;CN=Organizer:mailto:organizer@example.com", "SUMMARY:Sync", "END:VEVENT", "END:VCALENDAR");
	const invite = parseInvite(text);
	assert.equal(invite.startsAt.toISOString(), "2026-11-02T17:00:00.000Z");
	assert.equal(invite.endsAt.toISOString(), "2026-11-02T17:30:00.000Z");
	assert.equal(invite.organizer, "organizer@example.com");
	assert.equal(invite.timeZone, "America/Los_Angeles");
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
	const floating = parseInvite(event("DTSTART:20261110T100000", "DTEND:20261110T110000"), { timeZone: "America/Los_Angeles" });
	assert.equal(floating.startsAt.toISOString(), "2026-11-10T18:00:00.000Z");
	assert.equal(floating.timeZone, null);
	const unknown = parseInvite(event("DTSTART;TZID=Somewhere Odd:20261110T100000", "DTEND;TZID=Somewhere Odd:20261110T110000"), { timeZone: "America/Los_Angeles" });
	assert.equal(unknown.startsAt.toISOString(), "2026-11-10T18:00:00.000Z");
	assert.equal(unknown.endsAt.toISOString(), "2026-11-10T19:00:00.000Z");
	assert.equal(parseInvite(event("DTSTART:20261110T100000")).startsAt.toISOString(), "2026-11-10T10:00:00.000Z");
});

test("an all-day event covers the whole local day", () => {
	const withEnd = parseInvite(event("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106"), { timeZone: "America/Los_Angeles" });
	assert.equal(withEnd.allDay, true);
	assert.equal(withEnd.startsAt.toISOString(), "2026-11-05T08:00:00.000Z");
	assert.equal(withEnd.endsAt.toISOString(), "2026-11-06T08:00:00.000Z");
	const noEnd = parseInvite(event("DTSTART;VALUE=DATE:20261105"), { timeZone: "America/Los_Angeles" });
	assert.equal(noEnd.endsAt.toISOString(), "2026-11-06T08:00:00.000Z");
	// The day daylight saving ends is 25 hours long; the end is still the next local midnight.
	const dstDay = parseInvite(event("DTSTART;VALUE=DATE:20261101"), { timeZone: "America/Los_Angeles" });
	assert.equal(dstDay.startsAt.toISOString(), "2026-11-01T07:00:00.000Z");
	assert.equal(dstDay.endsAt.toISOString(), "2026-11-02T08:00:00.000Z");
	const multi = parseInvite(event("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261108"), { timeZone: "America/Los_Angeles" });
	assert.equal(multi.endsAt.toISOString(), "2026-11-08T08:00:00.000Z");
});

test("reads RECURRENCE-ID with the same zone rules", () => {
	const cancel = ics("BEGIN:VCALENDAR", "METHOD:CANCEL", "BEGIN:VEVENT", "UID:series-1", "RECURRENCE-ID;TZID=Pacific Standard Time:20261117T100000", "DTSTART;TZID=Pacific Standard Time:20261117T100000", "DTEND;TZID=Pacific Standard Time:20261117T110000", "SEQUENCE:3", "SUMMARY:Weekly", "END:VEVENT", "END:VCALENDAR");
	const invite = parseInvite(cancel, { timeZone: "UTC" });
	assert.equal(invite.method, "CANCEL");
	assert.equal(invite.recurrenceId.toISOString(), "2026-11-17T18:00:00.000Z");
	const utc = parseInvite(event("DTSTART:20261117T180000Z", "RECURRENCE-ID:20261117T180000Z"));
	assert.equal(utc.recurrenceId.toISOString(), "2026-11-17T18:00:00.000Z");
	const floating = parseInvite(event("DTSTART:20261117T100000", "RECURRENCE-ID:20261117T100000"), { timeZone: "America/Los_Angeles" });
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
	assert.deepEqual(planInboundInvite({ method: "REQUEST", recurrenceId: occurrence, sequence: 3 }, { inviteSequence: 1 }), { action: "upsert-override", occurrence });
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: occurrence, sequence: 3 }, null).action, "ignore");
	assert.deepEqual(planInviteAnswer({ method: "REQUEST", recurrenceId: occurrence, sequence: 0 }, "declined", { inviteSequence: 0 }), { action: "exclude", occurrence });
	assert.equal(planInviteAnswer({ method: "CANCEL", recurrenceId: occurrence, sequence: 0 }, "declined", { inviteSequence: 0 }).action, "exclude");
	assert.deepEqual(planInviteAnswer({ method: "REQUEST", recurrenceId: occurrence, sequence: 0 }, "accepted", { inviteSequence: 0 }), { action: "upsert-override", occurrence });
	assert.deepEqual(planInviteAnswer({ method: "REQUEST", recurrenceId: occurrence, sequence: 0 }, "tentative", { inviteSequence: 0 }), { action: "upsert-override", occurrence });
	assert.equal(planInviteAnswer({ method: "REQUEST", recurrenceId: occurrence, sequence: 0 }, "tentative", null).action, "none");
	assert.equal(planInviteAnswer({ method: "CANCEL", recurrenceId: occurrence, sequence: 0 }, "accepted", null).action, "none");
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

test("a stale CANCEL never deletes or excludes, on the series or one occurrence", () => {
	const occurrence = new Date("2026-11-17T18:00:00.000Z");
	assert.equal(planInboundInvite({ method: "CANCEL", recurrenceId: null, sequence: 1 }, { inviteSequence: 2 }).action, "ignore");
	assert.equal(planInboundInvite({ method: "CANCEL", recurrenceId: null, sequence: 2 }, { inviteSequence: 2 }).action, "delete");
	assert.equal(planInboundInvite({ method: "CANCEL", recurrenceId: occurrence, sequence: 1 }, { inviteSequence: 2 }).action, "ignore");
	assert.deepEqual(planInboundInvite({ method: "CANCEL", recurrenceId: occurrence, sequence: 2 }, { inviteSequence: 2 }), { action: "exclude", occurrence });
	assert.equal(planInboundInvite({ method: "REQUEST", recurrenceId: occurrence, sequence: 1 }, { inviteSequence: 2 }).action, "ignore");
	assert.equal(planInboundInvite({ method: "CANCEL", recurrenceId: null, sequence: 0 }, { inviteSequence: null }).action, "delete");
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
	assert.equal(inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2").repeat, "none");
	assert.equal(inviteRepeat("FREQ=MONTHLY;BYMONTHDAY=15").repeatAnchorDay, 15);
	assert.equal(inviteRepeat(null).repeat, "none");
	assert.equal(inviteRepeat("FREQ=WEEKLY").repeatUntil, null);
});

test("COUNT becomes an end that still includes the last occurrence", () => {
	const zone = "America/Los_Angeles";
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
	assert.equal(inviteRepeat("FREQ=DAILY;UNTIL=20261124", undefined, "America/Los_Angeles").repeatUntil.toISOString(), "2026-11-25T08:00:00.000Z");
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

test("reply text appends a guest note, or nothing when it is blank", () => {
	assert.equal(buildReplyText("guest@example.com", "accepted", "Planning"), "guest@example.com accepted: Planning");
	assert.equal(buildReplyText("guest@example.com", "tentatively accepted", "Planning", "Looking forward to it!  "), "guest@example.com tentatively accepted: Planning\n\nLooking forward to it!");
	assert.equal(buildReplyText("guest@example.com", "declined", "Planning", "line one\nline two\tend"), "guest@example.com declined: Planning\n\nline one\nline two\tend");
	for (const blank of ["", "   ", "\n\t  ", null, undefined]) assert.equal(buildReplyText("guest@example.com", "declined", "Planning", blank), "guest@example.com declined: Planning");
});

test("reply text truncates an over-long note and strips control characters", () => {
	const long = buildReplyText("guest@example.com", "accepted", "Planning", `${"  x".repeat(600)}  `);
	const note = long.split("\n\n")[1];
	assert.equal(note.length, 1000);
	assert.ok(long.startsWith("guest@example.com accepted: Planning\n\nx"));
	assert.equal(buildReplyText("guest@example.com", "accepted", "Planning", "hi\x00\x01\x07there\x7fbye"), "guest@example.com accepted: Planning\n\nhitherebye");
});

test("outgoing invitations fold long lines and end with CRLF", () => {
	const text = new TextDecoder().decode(createCalendarInvitation({ title: "T", description: "word ".repeat(40), location: "", startsAt: new Date("2026-11-04T17:00:00Z"), endsAt: new Date("2026-11-04T18:00:00Z"), uid: "evt_1", organizer: "me@example.com", attendees: ["guest@example.com"] }));
	assert.ok(text.endsWith("END:VCALENDAR\r\n"));
	for (const line of text.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
	const parsed = parseInvite(text);
	assert.equal(parsed.description, "word ".repeat(40).trim());
	assert.equal(parsed.organizer, "me@example.com");
});

test("an escaped backslash followed by n stays a backslash, not a line break", () => {
	const invite = parseInvite(event("DTSTART:20261104T170000Z", "SUMMARY:Notes in C:\\\\new", "DESCRIPTION:Share \\\\\\\\fs01\\\\new-hires\\nFloor 2", "LOCATION:Room \\\\N4"));
	assert.equal(invite.title, "Notes in C:\\new");
	assert.equal(invite.description, "Share \\\\fs01\\new-hires\nFloor 2");
	assert.equal(invite.location, "Room \\N4");
	const description = "Agenda in C:\\new\\notes.txt\nBring a laptop";
	const sent = new TextDecoder().decode(createCalendarInvitation({ title: "T", description, location: "", startsAt: new Date("2026-11-04T17:00:00Z"), endsAt: new Date("2026-11-04T18:00:00Z"), uid: "evt_1" }));
	assert.equal(parseInvite(sent).description, description);
});

test("sender-controlled size is bounded: EXDATE list and RRULE COUNT", () => {
	const dates = Array.from({ length: 5000 }, (_, i) => `2027${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T100000Z`).join(",");
	const started = Date.now();
	const invite = parseInvite(event("DTSTART:20261105T170000Z", "DTEND:20261105T180000Z", "RRULE:FREQ=WEEKLY", `EXDATE:${dates}`));
	assert.ok(invite.excludedDates.length <= 1000);
	assert.ok(JSON.parse(mergeExcludedOccurrences("[]", invite.excludedDates)).length <= 1000);
	// A COUNT reaching past about 200 years becomes a single event, never an endless series.
	const huge = inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=1000000", new Date("2026-11-02T17:00:00Z"), "America/Los_Angeles");
	assert.equal(huge.repeat, "none");
	assert.equal(huge.repeatUntil, null);
	const ok = inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=1000", new Date("2026-11-02T17:00:00Z"), "America/Los_Angeles");
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

test("EXDATE values are capped before they are parsed", (t) => {
	const values = (count) => Array.from({ length: count }, (_, i) => `2027${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T100000`).join(",");
	const invite = (count) => event("DTSTART;TZID=America/Los_Angeles:20261105T100000", "RRULE:FREQ=DAILY", `EXDATE;TZID=America/Los_Angeles:${values(count)}`, `EXDATE;TZID=Pacific Standard Time:${values(count)}`);
	// Every parsed date goes through Date.UTC, so counting calls measures parsing work without a wall-clock bound.
	const utc = t.mock.method(Date, "UTC");
	const parsedWith = (text) => {
		utc.mock.resetCalls();
		const result = parseInvite(text);
		return { excluded: result.excludedDates.length, calls: utc.mock.callCount() };
	};
	const capped = parsedWith(invite(1000));
	const huge = parsedWith(invite(15_000));
	assert.equal(capped.excluded, 1000);
	assert.equal(huge.excluded, 1000);
	assert.equal(huge.calls, capped.calls, "values past the cap were parsed");
});

test("COUNT of any size gives a finite end or a single event, quickly", () => {
	const zone = "America/Los_Angeles";
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
	const counted = inviteRepeat("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=6", new Date("2026-11-02T18:00:00.000Z"), "America/Los_Angeles");
	assert.equal(counted.repeatUntil.toISOString(), "2026-11-09T18:00:01.000Z");
});

test("one recipient zone: the account's, else the latest event's, else unknown", () => {
	assert.equal(chooseRecipientZone("America/Los_Angeles", "Europe/Paris"), "America/Los_Angeles");
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
	const invite = parseInvite(event("DTSTART;VALUE=DATE:20261105", "RECURRENCE-ID;VALUE=DATE:20261105", "SEQUENCE:1"), { timeZone: "America/Los_Angeles" });
	assert.equal(invite.recurrenceId.toISOString(), "2026-11-05T08:00:00.000Z");
	const reply = buildReplyIcs(invite, "guest@example.com", "declined");
	assert.match(reply, /\r\nDTSTART;VALUE=DATE:20261105\r\n/);
	assert.match(reply, /\r\nRECURRENCE-ID;VALUE=DATE:20261105\r\n/);
	const back = parseInvite(reply, { timeZone: "America/Los_Angeles" });
	assert.equal(back.recurrenceId.toISOString(), invite.recurrenceId.toISOString());
	// Timed occurrences keep UTC date-times.
	assert.match(buildReplyIcs(parseInvite(event("DTSTART:20261117T180000Z", "RECURRENCE-ID:20261117T180000Z")), "guest@example.com", "accepted"), /\r\nRECURRENCE-ID:20261117T180000Z\r\n/);
});

test("a missing METHOD defaults to PUBLISH but flags its absence", () => {
	const absent = parseInvite(ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:x", "DTSTART:20261104T170000Z", "END:VEVENT", "END:VCALENDAR"));
	assert.equal(absent.method, "PUBLISH");
	assert.equal(absent.methodAbsent, true);
	const explicit = parseInvite(ics("BEGIN:VCALENDAR", "METHOD:PUBLISH", "BEGIN:VEVENT", "UID:x", "DTSTART:20261104T170000Z", "END:VEVENT", "END:VCALENDAR"));
	assert.equal(explicit.method, "PUBLISH");
	assert.equal(explicit.methodAbsent, false);
	assert.equal(parseInvite(event("DTSTART:20261104T170000Z")).methodAbsent, false);
});

test("a VALARM TRIGGER becomes reminder minutes only for a plain countdown", () => {
	const withTrigger = (trigger, params = "") => parseInvite(ics("BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "DTSTART:20261104T170000Z",
		"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", `TRIGGER${params}:${trigger}`, "END:VALARM", "END:VEVENT", "END:VCALENDAR"));
	assert.equal(withTrigger("-PT15M").alarmMinutes, 15);
	assert.equal(withTrigger("-PT1H").alarmMinutes, 60);
	assert.equal(withTrigger("-P1D").alarmMinutes, 1440);
	assert.equal(withTrigger("-PT0M").alarmMinutes, 0);
	assert.equal(withTrigger("-PT15M", ";RELATED=START").alarmMinutes, 15);
	assert.equal(withTrigger("-pt15m", ";related=start").alarmMinutes, 15);
	assert.equal(withTrigger("PT15M").alarmMinutes, null);
	assert.equal(withTrigger("-PT15M", ";RELATED=END").alarmMinutes, null);
	assert.equal(withTrigger("-PT15M", ";VALUE=DATE-TIME").alarmMinutes, null);
	// 30 days is past the one-week reminder range.
	assert.equal(withTrigger("-P30D").alarmMinutes, null);
	// Past the DURATION cap entirely.
	assert.equal(withTrigger("-P400D").alarmMinutes, null);
	// No VALARM means no reminder.
	assert.equal(parseInvite(event("DTSTART:20261104T170000Z")).alarmMinutes, null);
	// Direct helper checks for the same grammar.
	assert.equal(parseAlarmTrigger(null), null);
});

test("outgoing invitations carry SEQUENCE 0 for creates and 1 for updates, with a VALARM only when reminded", () => {
	const base = { title: "T", description: "", location: "", startsAt: new Date("2026-11-04T17:00:00Z"), endsAt: new Date("2026-11-04T18:00:00Z"), uid: "evt_1" };
	const created = new TextDecoder().decode(createCalendarInvitation({ ...base }));
	assert.match(created, /\r\nSEQUENCE:0\r\n/);
	assert.doesNotMatch(created, /BEGIN:VALARM/);
	const updated = new TextDecoder().decode(createCalendarInvitation({ ...base, sequence: 1 }));
	assert.match(updated, /\r\nSEQUENCE:1\r\n/);
	const reminded = new TextDecoder().decode(createCalendarInvitation({ ...base, reminderMinutes: 15 }));
	assert.match(reminded, /\r\nBEGIN:VALARM\r\n/);
	assert.match(reminded, /\r\nTRIGGER:-PT15M\r\n/);
	assert.equal(parseInvite(reminded).alarmMinutes, 15);
	const atTime = new TextDecoder().decode(createCalendarInvitation({ ...base, sequence: 1, reminderMinutes: 0 }));
	assert.match(atTime, /\r\nTRIGGER:-PT0M\r\n/);
});

test("invitation addresses are stored as a flat validated list", () => {
	assert.deepEqual(inviteAttendeeAddresses({ organizer: "Org@Example.com", attendees: [{ email: "guest@example.com", status: "NEEDS-ACTION" }] }), ["org@example.com", "guest@example.com"]);
	// Duplicates collapse case-insensitively, junk is dropped.
	assert.deepEqual(inviteAttendeeAddresses({ organizer: null, attendees: [{ email: "GUEST@example.com", status: "ACCEPTED" }, { email: "guest@example.com", status: "TENTATIVE" }, { email: "not an address", status: "NEEDS-ACTION" }] }), ["guest@example.com"]);
	assert.deepEqual(inviteAttendeeAddresses({ organizer: null, attendees: [] }), []);
});

test("yearly invites map when plain or anchored on DTSTART", () => {
	assert.equal(inviteRepeat("FREQ=YEARLY").repeat, "yearly");
	const start = new Date("2026-11-04T17:00:00Z");
	const anchored = inviteRepeat("FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=4", start, "UTC");
	assert.equal(anchored.repeat, "yearly");
	assert.equal(inviteRepeat("FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=5", start, "UTC").repeat, "none");
	assert.equal(inviteRepeat("FREQ=YEARLY;BYMONTH=11", start, "UTC").repeat, "none");
	assert.equal(inviteRepeat("FREQ=YEARLY;BYDAY=MO", start, "UTC").repeat, "none");
	assert.equal(inviteRepeat("FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=4").repeat, "none");
});

test("INTERVAL steps daily, weekly, monthly and yearly repeats", () => {
	assert.deepEqual([inviteRepeat("FREQ=DAILY;INTERVAL=2").repeat, inviteRepeat("FREQ=DAILY;INTERVAL=2").repeatInterval], ["daily", 2]);
	assert.deepEqual([inviteRepeat("FREQ=WEEKLY;INTERVAL=3").repeat, inviteRepeat("FREQ=WEEKLY;INTERVAL=3").repeatInterval], ["weekly", 3]);
	const monthly = inviteRepeat("FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=2");
	assert.equal(monthly.repeat, "monthly");
	assert.equal(monthly.repeatInterval, 2);
	assert.equal(monthly.repeatAnchorDay, 15);
	assert.equal(inviteRepeat("FREQ=YEARLY;INTERVAL=2").repeatInterval, 2);
	assert.equal(inviteRepeat("FREQ=DAILY;INTERVAL=0").repeat, "none");
	assert.equal(inviteRepeat("FREQ=DAILY;INTERVAL=1000").repeat, "none");
	assert.equal(inviteRepeat("FREQ=DAILY;INTERVAL=many").repeat, "none");
	// A listed-days repeat steps day by day, so an interval cannot be stored.
	assert.equal(inviteRepeat("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=2").repeat, "none");
	assert.equal(inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2").repeat, "none");
	const weekdays = inviteRepeat("FREQ=WEEKLY;BYDAY=MO,WE");
	assert.equal(weekdays.repeat, "weekdays");
	assert.equal(weekdays.repeatInterval, 1);
});

test("a single numeric BYDAY maps monthly onto the nth weekday", () => {
	const second = inviteRepeat("FREQ=MONTHLY;BYDAY=2TU");
	assert.equal(second.repeat, "monthly");
	assert.equal(second.repeatWeekday, 2);
	assert.equal(second.repeatWeek, 2);
	const last = inviteRepeat("FREQ=MONTHLY;BYDAY=-1FR");
	assert.equal(last.repeat, "monthly");
	assert.equal(last.repeatWeekday, 5);
	assert.equal(last.repeatWeek, -1);
	const stepped = inviteRepeat("FREQ=MONTHLY;BYDAY=2TU;INTERVAL=3");
	assert.equal(stepped.repeat, "monthly");
	assert.equal(stepped.repeatInterval, 3);
	assert.equal(stepped.repeatWeek, 2);
	assert.equal(inviteRepeat("FREQ=MONTHLY;BYDAY=MO,TU").repeat, "none");
	assert.equal(inviteRepeat("FREQ=MONTHLY;BYDAY=MO").repeat, "none");
	assert.equal(inviteRepeat("FREQ=MONTHLY;BYDAY=2TU;BYSETPOS=1").repeat, "none");
	assert.equal(inviteRepeat("FREQ=MONTHLY;BYDAY=6TU").repeat, "none");
	assert.equal(inviteRepeat("FREQ=MONTHLY;BYDAY=0TU").repeat, "none");
});

test("RDATE values parse like EXDATE values and cap at 1000", () => {
	const invite = parseInvite(event("DTSTART:20261105T170000Z", "RRULE:FREQ=DAILY", "RDATE:20261106T170000Z,20261107T170000Z"));
	assert.deepEqual(invite.rdateDates.map((date) => date.toISOString()), ["2026-11-06T17:00:00.000Z", "2026-11-07T17:00:00.000Z"]);
	const zoned = parseInvite(event("DTSTART;TZID=America/Los_Angeles:20261105T100000", "RDATE;TZID=America/Los_Angeles:20261106T100000"), { timeZone: "UTC" });
	assert.equal(zoned.rdateDates[0].toISOString(), "2026-11-06T18:00:00.000Z");
	const dates = Array.from({ length: 1500 }, (_, i) => `2027${String(1 + (i % 12)).padStart(2, "0")}15T100000Z`).join(",");
	assert.equal(parseInvite(event("DTSTART:20261105T170000Z", `RDATE:${dates}`)).rdateDates.length, 1000);
	assert.deepEqual(parseInvite(event("DTSTART:20261105T170000Z")).rdateDates, []);
});

test("a yearly COUNT from February 29 clamps to February 28", () => {
	const until = inviteRepeat("FREQ=YEARLY;COUNT=2", new Date("2024-02-29T10:00:00Z"), "UTC").repeatUntil?.toISOString();
	assert.equal(until, "2025-02-28T10:00:01.000Z");
	const monthly = inviteRepeat("FREQ=YEARLY;COUNT=5", new Date("2024-02-29T10:00:00Z"), "UTC");
	assert.equal(monthly.repeat, "yearly");
	assert.equal(monthly.repeatUntil.toISOString(), "2028-02-29T10:00:01.000Z");
});

test("tool expansion steps every two weeks with INTERVAL", () => {
	const row = (repeat, extra = {}) => ({
		id: "evt_1", title: "T", description: "", location: "", attendees: "[]", color: "#2563eb", repeat,
		repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null,
		excludedOccurrences: "[]", timeZone: "UTC", startsAt: new Date("2026-11-02T17:00:00Z"), endsAt: new Date("2026-11-02T17:30:00Z"), ...extra,
	});
	const biweekly = expandToolEvents([row("weekly", { repeatInterval: 2 })], new Date("2026-11-01T00:00:00Z"), new Date("2026-12-15T00:00:00Z"));
	assert.deepEqual(biweekly.map((item) => item.startsAt), ["2026-11-02T17:00:00.000Z", "2026-11-16T17:00:00.000Z", "2026-11-30T17:00:00.000Z", "2026-12-14T17:00:00.000Z"]);
	const yearly = expandToolEvents([row("yearly")], new Date("2026-11-01T00:00:00Z"), new Date("2028-12-01T00:00:00Z"));
	assert.deepEqual(yearly.map((item) => item.startsAt.slice(0, 10)), ["2026-11-02", "2027-11-02", "2028-11-02"]);
	const leap = expandToolEvents([row("yearly", { startsAt: new Date("2024-02-29T10:00:00Z"), endsAt: new Date("2024-02-29T11:00:00Z") })], new Date("2024-01-01T00:00:00Z"), new Date("2027-01-01T00:00:00Z"));
	assert.deepEqual(leap.map((item) => item.startsAt.slice(0, 10)), ["2024-02-29", "2025-02-28", "2026-02-28"]);
	const nth = expandToolEvents([row("monthly", { startsAt: new Date("2026-11-10T17:00:00Z"), endsAt: new Date("2026-11-10T17:30:00Z"), repeatWeekday: 2, repeatWeek: 2 })], new Date("2026-11-01T00:00:00Z"), new Date("2027-02-01T00:00:00Z"));
	assert.deepEqual(nth.map((item) => item.startsAt.slice(0, 10)), ["2026-11-10", "2026-12-08", "2027-01-12"]);
	const last = expandToolEvents([row("monthly", { startsAt: new Date("2026-10-30T17:00:00Z"), endsAt: new Date("2026-10-30T17:30:00Z"), repeatWeekday: 5, repeatWeek: -1 })], new Date("2026-11-01T00:00:00Z"), new Date("2027-01-01T00:00:00Z"));
	assert.deepEqual(last.map((item) => item.startsAt.slice(0, 10)), ["2026-11-27", "2026-12-25"]);
});

test("tool expansion replaces an overridden occurrence and adds extra ones", () => {
	const row = {
		id: "evt_1", title: "T", description: "", location: "", attendees: "[]", color: "#2563eb", repeat: "weekly",
		repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null,
		excludedOccurrences: "[]", timeZone: "UTC", startsAt: new Date("2026-11-02T17:00:00Z"), endsAt: new Date("2026-11-02T17:30:00Z"),
	};
	const movedMs = Date.parse("2026-11-09T17:00:00Z");
	const start = new Date("2026-11-01T00:00:00Z");
	const end = new Date("2026-11-20T00:00:00Z");
	const overrides = new Map([["evt_1", [
		{ occurrenceMs: movedMs, startsAt: new Date("2026-11-09T19:00:00Z"), endsAt: new Date("2026-11-09T19:30:00Z") },
		{ occurrenceMs: Date.parse("2026-11-11T12:00:00Z"), startsAt: new Date("2026-11-11T12:00:00Z"), endsAt: new Date("2026-11-11T13:00:00Z") },
	]]]);
	const items = expandToolEvents([row], start, end, 500, overrides);
	assert.deepEqual(items.map((item) => item.startsAt), ["2026-11-02T17:00:00.000Z", "2026-11-09T19:00:00.000Z", "2026-11-11T12:00:00.000Z", "2026-11-16T17:00:00.000Z"]);
	// The replaced occurrence keeps its occurrence identity; the extra one is keyed by its RDATE instant.
	assert.deepEqual(items.map((item) => item.id), [Date.parse("2026-11-02T17:00:00Z"), movedMs, Date.parse("2026-11-11T12:00:00Z"), Date.parse("2026-11-16T17:00:00Z")].map((ms) => `evt_1@${ms}`));
	// Without overrides the same window holds just the plain rule occurrences.
	assert.deepEqual(expandToolEvents([row], start, end).map((item) => item.startsAt), ["2026-11-02T17:00:00.000Z", "2026-11-09T17:00:00.000Z", "2026-11-16T17:00:00.000Z"]);
});

test("outgoing recurring invitations carry RRULE, EXDATE and RECURRENCE-ID overrides", () => {
	const startsAt = new Date("2026-11-10T17:00:00Z");
	const endsAt = new Date("2026-11-10T17:30:00Z");
	const recurrenceId = new Date("2026-12-15T17:00:00Z");
	const text = new TextDecoder().decode(createCalendarInvitation({
		title: "Team sync", description: "Weekly", location: "Room 1",
		startsAt, endsAt, uid: "evt_series", organizer: "me@example.com",
		attendees: ["guest@example.com"], sequence: 5, reminderMinutes: 15,
		repeat: "monthly", repeatDays: [], repeatAnchorDay: null,
		repeatUntil: new Date("2027-06-08T17:00:00Z"),
		repeatInterval: 3, repeatWeekday: 2, repeatWeek: 2,
		excludedOccurrences: [Date.parse("2026-12-08T17:00:00Z")],
		overrides: [{ recurrenceId, startsAt: new Date("2026-12-15T19:00:00Z"), endsAt: new Date("2026-12-15T19:30:00Z") }],
	}));
	assert.match(text, /RRULE:FREQ=MONTHLY;BYDAY=2TU;INTERVAL=3;UNTIL=20270608T170000Z/);
	assert.match(text, /EXDATE:20261208T170000Z/);
	assert.match(text, /RECURRENCE-ID:20261215T170000Z/);
	assert.match(text, /\r\nSEQUENCE:5\r\n/);
	assert.match(text, /\r\nBEGIN:VALARM\r\n/);
	const back = parseInvite(text);
	assert.equal(back.sequence, 5);
	assert.equal(back.rrule, "FREQ=MONTHLY;BYDAY=2TU;INTERVAL=3;UNTIL=20270608T170000Z");
	assert.deepEqual(back.excludedDates.map((date) => date.toISOString()), ["2026-12-08T17:00:00.000Z"]);
	const repeat = inviteRepeat(back.rrule);
	assert.equal(repeat.repeat, "monthly");
	assert.equal(repeat.repeatWeekday, 2);
	assert.equal(repeat.repeatWeek, 2);
	assert.equal(repeat.repeatInterval, 3);
	// The file with an override still reads as the series.
	assert.equal(back.title, "Team sync");
	assert.equal(back.organizer, "me@example.com");
	// A yearly series with a step emits FREQ=YEARLY with INTERVAL and parses back.
	const yearly = new TextDecoder().decode(createCalendarInvitation({
		title: "Anniversary", description: "", location: "",
		startsAt, endsAt, uid: "evt_yearly", sequence: 2,
		repeat: "yearly", repeatDays: [], repeatAnchorDay: null, repeatUntil: null,
		repeatInterval: 2, repeatWeekday: null, repeatWeek: null,
		excludedOccurrences: [], overrides: [],
	}));
	assert.match(yearly, /RRULE:FREQ=YEARLY;INTERVAL=2/);
	assert.equal(inviteRepeat(parseInvite(yearly).rrule).repeatInterval, 2);
	assert.match(yearly, /\r\nSEQUENCE:2\r\n/);
});

test("split announcement truncates the original UID and invites the fork UID", () => {
	const { truncationFile, forkFile } = buildSplitAnnouncement({
		original: {
			uid: "evt_orig", title: "Team sync", description: "Weekly", location: "Room 1",
			startsAt: new Date("2026-11-10T17:00:00Z"), endsAt: new Date("2026-11-10T17:30:00Z"),
			repeat: "weekly", repeatDays: [], repeatAnchorDay: null, repeatUntil: new Date("2026-11-24T17:00:00Z"),
			repeatInterval: 1, repeatWeekday: null, repeatWeek: null, reminderMinutes: null,
			excludedOccurrences: [Date.parse("2026-11-17T17:00:00Z")],
			overrides: [{ recurrenceId: new Date("2026-11-12T17:00:00Z"), startsAt: new Date("2026-11-12T19:00:00Z"), endsAt: new Date("2026-11-12T19:30:00Z") }],
			sequence: 3,
		},
		fork: {
			uid: "evt_fork", title: "Team sync", description: "Weekly", location: "Room 1",
			startsAt: new Date("2026-11-24T17:00:00Z"), endsAt: new Date("2026-11-24T17:30:00Z"),
			repeat: "weekly", repeatDays: [], repeatAnchorDay: null, repeatUntil: null,
			repeatInterval: 1, repeatWeekday: null, repeatWeek: null, reminderMinutes: null,
			excludedOccurrences: [], overrides: [],
			sequence: 0,
		},
		organizer: "me@example.com", attendees: ["guest@example.com"],
	});
	const truncation = new TextDecoder().decode(truncationFile);
	const fork = new TextDecoder().decode(forkFile);
	// File (1) keeps the original DTSTART with UNTIL at the split, the EXDATE and the pre-split override.
	assert.match(truncation, /UID:evt_orig@mailflare/);
	assert.match(truncation, /DTSTART:20261110T170000Z/);
	assert.match(truncation, /RRULE:FREQ=WEEKLY;UNTIL=20261124T170000Z/);
	assert.match(truncation, /\r\nSEQUENCE:3\r\n/);
	assert.match(truncation, /EXDATE:20261117T170000Z/);
	assert.match(truncation, /RECURRENCE-ID:20261112T170000Z/);
	assert.doesNotMatch(truncation, /evt_fork/);
	// File (2) is a new series under the fork UID starting at the split.
	assert.match(fork, /UID:evt_fork@mailflare/);
	assert.match(fork, /DTSTART:20261124T170000Z/);
	assert.match(fork, /\r\nSEQUENCE:0\r\n/);
	assert.match(fork, /RRULE:FREQ=WEEKLY\r\n/);
	assert.doesNotMatch(fork, /evt_orig/);
});

test("a counter proposal carries the proposed times and round-trips", () => {
	const invite = parseInvite(mailflare);
	const proposal = buildCounterIcs(invite, "guest@example.com", { startsAt: new Date("2026-11-05T10:00:00.000Z"), endsAt: new Date("2026-11-05T11:00:00.000Z") }, { message: "How about this?" });
	assert.match(proposal, /METHOD:COUNTER/);
	assert.match(proposal, /DTSTART:20261105T100000Z/);
	assert.match(proposal, /DTEND:20261105T110000Z/);
	assert.match(proposal, /ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com/);
	assert.ok(proposal.endsWith("END:VCALENDAR\r\n"));
	for (const line of proposal.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
	const back = parseInvite(proposal);
	assert.equal(back.method, "COUNTER");
	assert.equal(back.uid, "evt_abc@mailflare");
	assert.equal(back.startsAt.toISOString(), "2026-11-05T10:00:00.000Z");
	assert.equal(back.endsAt.toISOString(), "2026-11-05T11:00:00.000Z");
	assert.equal(back.description, "How about this?");
	// Without a message there is no DESCRIPTION line, and a lone occurrence keeps its id.
	const bare = buildCounterIcs(parseInvite(event("DTSTART:20261104T170000Z", "RECURRENCE-ID:20261104T170000Z", "SEQUENCE:2")), "guest@example.com", { startsAt: new Date("2026-11-06T10:00:00.000Z"), endsAt: new Date("2026-11-06T11:00:00.000Z") });
	assert.doesNotMatch(bare, /DESCRIPTION/);
	assert.match(bare, /\r\nRECURRENCE-ID:20261104T170000Z\r\n/);
	assert.match(bare, /\r\nSEQUENCE:2\r\n/);
	assert.equal(parseInvite(bare).recurrenceId.toISOString(), "2026-11-04T17:00:00.000Z");
});

test("an all-day counter keeps DATE types for the proposal and RECURRENCE-ID", () => {
	const invite = parseInvite(event("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106", "RECURRENCE-ID;VALUE=DATE:20261105", "SEQUENCE:1", "RRULE:FREQ=DAILY"), { timeZone: "America/Los_Angeles" });
	assert.equal(invite.allDay, true);
	const counter = buildCounterIcs(invite, "guest@example.com", { startsAt: new Date("2026-11-06T08:00:00.000Z"), endsAt: new Date("2026-11-07T08:00:00.000Z") }, { message: "How about Friday?" });
	assert.match(counter, /\r\nDTSTART;VALUE=DATE:20261106\r\n/);
	assert.match(counter, /\r\nDTEND;VALUE=DATE:20261107\r\n/);
	assert.match(counter, /\r\nRECURRENCE-ID;VALUE=DATE:20261105\r\n/);
	const back = parseInvite(counter, { timeZone: "America/Los_Angeles" });
	assert.equal(back.allDay, true);
	assert.equal(back.recurrenceId.toISOString(), invite.recurrenceId.toISOString());
});

test("counter proposals need a valid range on a REQUEST invitation", () => {
	assert.deepEqual(parseCounterProposal("2026-11-05T10:00:00.000Z", "2026-11-05T11:00:00.000Z"), { startsAt: new Date("2026-11-05T10:00:00.000Z"), endsAt: new Date("2026-11-05T11:00:00.000Z") });
	// The end must be after the start.
	assert.equal(parseCounterProposal("2026-11-05T11:00:00.000Z", "2026-11-05T10:00:00.000Z"), null);
	assert.equal(parseCounterProposal("2026-11-05T10:00:00.000Z", "2026-11-05T10:00:00.000Z"), null);
	// Both ends must be readable ISO datetimes.
	assert.equal(parseCounterProposal("not a date", "2026-11-05T10:00:00.000Z"), null);
	assert.equal(parseCounterProposal("2026-11-05T10:00:00.000Z", undefined), null);
	assert.equal(parseCounterProposal(null, null), null);
	// The route only counters REQUEST invitations; anything else is rejected there.
	assert.equal(parseInvite(mailflare).method, "REQUEST");
	const reply = parseInvite(buildReplyIcs(parseInvite(mailflare), "guest@example.com", "accepted"));
	assert.notEqual(reply.method, "REQUEST");
});

test("a crafted ORGANIZER of repeated @ cannot exhaust the CPU (CWE-1333)", () => {
	const huge = "@".repeat(64 * 1024);
	// The value is dropped at parse time ...
	const parsed = parseInvite(event("DTSTART:20261110T100000Z", `ORGANIZER:mailto:${huge}`, "SUMMARY:x"));
	assert.equal(parsed.organizer, null);
	// ... and the address check itself stays linear even for a value that bypasses the parser.
	const invite = { ...parseInvite(event("DTSTART:20261110T100000Z", "SUMMARY:x")), organizer: huge };
	const started = performance.now();
	const reply = buildReplyIcs(invite, huge, "accepted");
	assert.ok(performance.now() - started < 20, "finishes quickly");
	assert.ok(!reply.includes("ORGANIZER"));
	assert.ok(reply.includes("mailto:unknown@invalid"));
	const outgoing = createCalendarInvitation({ title: "t", description: "", location: "", startsAt: new Date(0), endsAt: new Date(1), uid: "u", organizer: huge, attendees: [huge] });
	assert.ok(!new TextDecoder().decode(outgoing).includes("ORGANIZER"));
});

test("ordinary addresses are still written to a reply", () => {
	const invite = { ...parseInvite(event("DTSTART:20261110T100000Z", "ORGANIZER:mailto:o.rganizer+tag@example.com", "SUMMARY:x")) };
	assert.equal(invite.organizer, "o.rganizer+tag@example.com");
	const reply = buildReplyIcs(invite, "me@example.org", "declined");
	assert.ok(reply.includes("ORGANIZER:mailto:o.rganizer+tag@example.com"));
	assert.ok(reply.includes("PARTSTAT=DECLINED:mailto:me@example.org"));
});

test("a failing invitation is reported per attendee instead of rejecting", async () => {
	const sent = [];
	const failed = await sendToAttendees(["a@example.com", "b@example.com", "c@example.com"], async (to) => {
		if (to === "b@example.com") throw new Error("sender not authorized");
		sent.push(to);
	});
	assert.deepEqual(failed, ["b@example.com"]);
	assert.deepEqual(sent, ["a@example.com", "c@example.com"]);
	assert.deepEqual(await sendToAttendees([], async () => { throw new Error("unused"); }), []);
});

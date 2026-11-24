import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// GET /api/export/calendar downloads the whole calendar as an .ics attachment.
const mocks = {
	"@/lib/cloudflare": `export function getEnv(){return globalThis.calExportEnv}`,
	"@/lib/auth/cookies": `export async function getCurrentUser(){return globalThis.calExportUser}`,
	"@/lib/api/key-auth": `export async function authenticateApiRequest(){return globalThis.calExportKey} export async function authenticateApiKeyValue(){return null} export function hasScope(scopes,required){return scopes.includes(required)||scopes.includes("*")}`,
};
const { app, newDatabase } = await loadApp("cal-export", `export * as route from "./src/app/api/export/calendar/route.ts";`, { mocks });

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const monday = sec("2026-11-02T17:00:00Z"); // 09:00 in America/Los_Angeles
const longText = "Long description with é and more text ".repeat(4).trim();
const controlChars = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]");
const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('user-1', 'u@example.com', 'hash', 'User', 'user', 1),
		('user-2', 'empty@example.com', 'hash', 'Empty', 'user', 1);
	INSERT INTO calendar_events (id, user_id, title, description, location, attendees, repeat, repeat_days, repeat_anchor_day, repeat_until, repeat_interval, repeat_weekday, repeat_week, excluded_occurrences, time_zone, reminder_minutes, response_status, attendee_responses, starts_at, ends_at, created_at, updated_at) VALUES
		('evt-one', 'user-1', 'One, off; "quoted"', '${longText}', 'Room, 2', '["Guest@Example.com ","other@example.com","not-an-email"]', 'none', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, 15, NULL, '{"guest@example.com":"accepted","other@example.com":"declined"}', ${sec("2026-11-03T17:00:00Z")}, ${sec("2026-11-03T18:00:00Z")}, 1, 1),
		('evt-daily', 'user-1', 'Every other day', '', '', '[]', 'daily', '[]', NULL, ${sec("2026-11-10T17:00:00Z")}, 2, NULL, NULL, '[]', NULL, NULL, NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-weekly', 'user-1', 'Weekly sync', 'Weekly notes', '', '[]', 'weekly', '[]', NULL, NULL, 1, NULL, NULL, '[${Date.parse("2026-11-09T17:00:00Z")}]', 'America/Los_Angeles', NULL, NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-weekdays', 'user-1', 'Mon Wed Fri', '', '', '[]', 'weekdays', '[1,3,5]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-monthly', 'user-1', 'Monthly', '', '', '[]', 'monthly', '[]', 15, NULL, 1, NULL, NULL, '[]', NULL, NULL, NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-monthly31', 'user-1', 'End of month', '', '', '[]', 'monthly', '[]', 31, NULL, 1, NULL, NULL, '[]', NULL, NULL, NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-nth', 'user-1', 'Second Tuesday', '', '', '[]', 'monthly', '[]', NULL, NULL, 1, 2, 2, '[]', NULL, NULL, NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-fifth', 'user-1', 'Fifth Monday', '', '', '[]', 'monthly', '[]', NULL, NULL, 1, 1, 5, '[]', NULL, NULL, NULL, NULL, ${sec("2026-03-30T17:00:00Z")}, ${sec("2026-03-30T17:30:00Z")}, 1, 1),
		('evt-leap', 'user-1', 'Leap day', '', '', '[]', 'yearly', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, NULL, NULL, ${sec("2024-02-29T17:00:00Z")}, ${sec("2024-02-29T17:30:00Z")}, 1, 1),
		('evt-yearly', 'user-1', 'Yearly', '', '', '[]', 'yearly', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, 'tentative', NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-future', 'user-1', 'December weekly', '', '', '[]', 'weekly', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, NULL, NULL, ${sec("2026-12-01T09:00:00Z")}, ${sec("2026-12-01T10:00:00Z")}, 1, 1),
		('evt-old', 'user-1', 'Since 1970', '', '', '[]', 'daily', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, NULL, NULL, ${sec("1970-01-01T17:00:00Z")}, ${sec("1970-01-01T18:00:00Z")}, 1, 1),
		('evt-london', 'user-1', 'London weekly', '', '', '[]', 'weekly', '[]', NULL, ${sec("2042-01-01T00:00:00Z")}, 1, NULL, NULL, '[]', 'Europe/London', NULL, NULL, NULL, ${sec("2026-03-02T09:00:00Z")}, ${sec("2026-03-02T10:00:00Z")}, 1, 1),
		('evt-eon', 'user-1', 'Deep future weekly', '', '', '[]', 'weekly', '[]', NULL, ${sec("9998-11-02T00:00:00Z")}, 1, NULL, NULL, '[]', 'America/Los_Angeles', NULL, NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-pending', 'user-1', 'Pending invite', '', '', '[]', 'none', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, 'needs-action', NULL, ${monday}, ${monday + 1800}, 1, 1);
	INSERT INTO calendar_event_overrides (id, event_id, occurrence_ms, starts_at, ends_at, title, description, location, created_at, updated_at) VALUES
		('ov-1', 'evt-weekly', ${Date.parse("2026-11-16T17:00:00Z")}, ${sec("2026-11-16T19:00:00Z")}, ${sec("2026-11-16T20:00:00Z")}, 'Moved sync', NULL, 'Video', 1, 1),
		('ov-2', 'evt-weekly', ${Date.parse("2026-11-12T17:00:00Z")}, ${sec("2026-11-12T17:00:00Z")}, ${sec("2026-11-12T17:30:00Z")}, NULL, NULL, NULL, 1, 1),
		('ov-3', 'evt-future', ${Date.parse("2026-12-08T09:00:00Z")}, ${sec("2026-11-03T09:00:00Z")}, ${sec("2026-11-03T10:00:00Z")}, NULL, NULL, NULL, 1, 1),
		('ov-4', 'evt-weekdays', ${Date.parse("2026-11-05T17:00:00Z")}, ${sec("2026-11-05T17:00:00Z")}, ${sec("2026-11-05T17:30:00Z")}, NULL, NULL, NULL, 1, 1),
		('ov-5', 'evt-old', ${Date.parse("1970-01-01T17:00:00Z") + 20000 * 86400000}, ${sec("2024-10-04T19:00:00Z")}, ${sec("2024-10-04T20:00:00Z")}, 'Still edited', NULL, NULL, 1, 1);
`;

const sessionUser = { id: "user-1", calendarEnabled: true };
const keyWith = (scopes) => ({ keyId: "k1", userId: "user-1", scopes, mailboxIds: null, user: sessionUser });
const req = (path = "/api/export/calendar", headers = {}) => new Request(`http://localhost${path}`, { headers });

async function setup(t, { user = sessionUser, key = null } = {}) {
	const { env } = await newDatabase(t, seed);
	globalThis.calExportEnv = env;
	globalThis.calExportUser = user;
	globalThis.calExportKey = key;
}

async function download(t, request = req()) {
	await setup(t);
	const res = await app.route.GET(request);
	assert.equal(res.status, 200);
	return res;
}

test("the session owner gets the calendar as a downloadable attachment", async (t) => {
	const res = await download(t);
	assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
	assert.equal(res.headers.get("content-disposition"), 'attachment; filename="mailflare-calendar.ics"');
	assert.equal(res.headers.get("cache-control"), "no-store");
	const ics = await res.text();
	assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
	assert.match(ics, /\r\nVERSION:2\.0\r\n/);
	assert.match(ics, /\r\nPRODID:-\/\/Mailflare\/\/Calendar\/\/EN\r\n/);
	// A saved snapshot is a neutral transfer, not a published feed: no METHOD, since PUBLISH would
	// require ORGANIZER next to every ATTENDEE (RFC 5546 3.2.1).
	assert.doesNotMatch(ics, /\r\nMETHOD:/);
	assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
	// A snapshot is not polled, so it carries no subscription refresh hints.
	assert.doesNotMatch(ics, /REFRESH-INTERVAL|X-PUBLISHED-TTL/);
});

test("a Bearer key needs the calendar:read scope", async (t) => {
	await setup(t, { user: null, key: keyWith(["jmap"]) });
	assert.equal((await app.route.GET(req("/api/export/calendar", { authorization: "Bearer ep_k" }))).status, 403);
	await setup(t, { user: null, key: keyWith(["calendar:read"]) });
	assert.equal((await app.route.GET(req("/api/export/calendar", { authorization: "Bearer ep_k" }))).status, 200);
});

test("no session and no key is a 401", async (t) => {
	await setup(t, { user: null });
	assert.equal((await app.route.GET(req())).status, 401);
});

test("every event becomes a VEVENT with its rule, exclusions and alarm", async (t) => {
	const ics = await (await download(t)).text();
	const masters = ics.split("BEGIN:VEVENT").length - 1;
	assert.equal(masters, 17); // Fourteen events plus three moved occurrences; the bare extras are RDATEs and the pending invite stays out.
	assert.doesNotMatch(ics, /Pending invite/);
	assert.match(ics, /UID:evt-one@mailflare\r\n/);
	assert.match(ics, /DTSTART:20261103T170000Z\r\n/);
	// none -> no RRULE on evt-one.
	const one = ics.slice(ics.indexOf("UID:evt-one"), ics.indexOf("END:VEVENT", ics.indexOf("UID:evt-one")));
	assert.doesNotMatch(one, /RRULE/);
	assert.match(ics, /RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261110T165959Z\r\n/);
	assert.match(ics, /RRULE:FREQ=WEEKLY\r\n/);
	assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\n/);
	assert.match(ics, /RRULE:FREQ=MONTHLY;BYMONTHDAY=15\r\n/);
	assert.match(ics, /RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1\r\n/);
	assert.match(ics, /RRULE:FREQ=MONTHLY;BYDAY=2TU\r\n/);
	assert.match(ics, /RRULE:FREQ=YEARLY\r\n/);
	assert.match(ics, /STATUS:TENTATIVE\r\n/);
	// The app's clamps are written, not stock rules: fifth-Monday becomes last-Monday (2026-03-30 ->
	// 2026-04-27 under BYDAY=5MO would skip April's four weeks) and Feb 29 lists the last day of
	// February (a bare YEARLY would skip 2025, BYMONTHDAY=29 alone would roll to Mar 1) — both verified
	// to expand to the app's occurrences under ical.js.
	assert.match(ics, /RRULE:FREQ=MONTHLY;BYDAY=-1MO\r\n/);
	assert.match(ics, /RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1\r\n/);
	// A zoned series keeps local times and writes its exclusions with the same TZID.
	assert.match(ics, /DTSTART;TZID=America\/Los_Angeles:20261102T090000\r\n/);
	assert.match(ics, /EXDATE;TZID=America\/Los_Angeles:20261109T090000\r\n/);
});

test("every cited TZID gets a VTIMEZONE, and an extra occurrence exports as RDATE", async (t) => {
	const ics = await (await download(t)).text();
	// Without this block a stock parser resolves TZID times as floating and shifts the series.
	assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/Los_Angeles\r\n/);
	assert.match(ics, /BEGIN:STANDARD\r\nDTSTART:\d{8}T020000\r\nTZOFFSETFROM:-0700\r\nTZOFFSETTO:-0800\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;UNTIL=\d{8}T\d{6}\r\nEND:STANDARD\r\n/);
	assert.match(ics, /BEGIN:DAYLIGHT\r\nDTSTART:\d{8}T020000\r\nTZOFFSETFROM:-0800\r\nTZOFFSETTO:-0700\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;UNTIL=\d{8}T\d{6}\r\nEND:DAYLIGHT\r\n/);
	// ov-2 sits on a Thursday where the Monday rule has no occurrence: it is an extra, declared as an
	// RDATE on the master instead of a detached VEVENT a parser could not attach anywhere.
	const weekly = ics.slice(ics.indexOf("UID:evt-weekly"), ics.indexOf("END:VEVENT", ics.indexOf("UID:evt-weekly")));
	assert.match(weekly, /RDATE;TZID=America\/Los_Angeles:20261112T090000\r\n/);
	// The London VTIMEZONE must last the series' own lifetime: inferred to the verified -1SU rule,
	// never a fourth-Sunday guess that would shift 2041's five-Sunday March by an hour.
	assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/London\r\n/);
	assert.match(ics, /BYMONTH=3;BYDAY=-1SU/);
	assert.doesNotMatch(ics, /BYDAY=4SU/);
});

test("a series past the probe budget degrades to UTC instead of scanning millennia", async (t) => {
	const ics = await (await download(t)).text();
	// evt-eon cites instants to 9998 — ~2.9M daily probes — so its window is dropped and the series
	// exports with Z-forms: instants stay exact, only the TZID is lost. evt-weekly's ordinary window
	// still fits the budget and keeps its TZID + VTIMEZONE.
	const eon = ics.slice(ics.indexOf("UID:evt-eon"), ics.indexOf("END:VEVENT", ics.indexOf("UID:evt-eon")));
	assert.match(eon, /DTSTART:20261102T170000Z\r\n/);
	assert.doesNotMatch(eon, /TZID=/);
	const weekly = ics.slice(ics.indexOf("UID:evt-weekly"), ics.indexOf("END:VEVENT", ics.indexOf("UID:evt-weekly")));
	assert.match(weekly, /DTSTART;TZID=America\/Los_Angeles:/);
	assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/Los_Angeles\r\n/);
});

test("a weekday the repeat filters out takes the extra as RDATE, far slots stay exceptions", async (t) => {
	const ics = await (await download(t)).text();
	// ov-4 is Thursday on the M/W/F weekdays repeat: not a rule occurrence, so an RDATE extra.
	const weekdays = ics.slice(ics.indexOf("UID:evt-weekdays"), ics.indexOf("END:VEVENT", ics.indexOf("UID:evt-weekdays")));
	assert.match(weekdays, /RDATE:20261105T170000Z\r\n/);
	// ov-5 sits on the daily rule's 20000th slot: an exception with RECURRENCE-ID and no RDATE, or a
	// parser would import the occurrence twice — the classifier computes the slot, it does not scan.
	const old = ics.slice(ics.indexOf("UID:evt-old"), ics.indexOf("END:VEVENT", ics.indexOf("UID:evt-old")));
	assert.doesNotMatch(old, /RDATE/);
	assert.match(ics, /RECURRENCE-ID:20241004T170000Z\r\nDTSTART:20241004T190000Z\r\n/);
});

test("a download carries guests with their RSVP state and the reminder", async (t) => {
	const ics = await (await download(t)).text();
	assert.match(ics, /ATTENDEE;PARTSTAT=ACCEPTED:mailto:Guest@Example.com\r\n/);
	assert.match(ics, /ATTENDEE;PARTSTAT=DECLINED:mailto:other@example.com\r\n/);
	// An address that is not a plain mailbox never reaches the file.
	assert.doesNotMatch(ics, /not-an-email/);
	assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:One\\, off\\; "quoted"\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n/);
});

test("the moved occurrence re-specifies its time and effective text", async (t) => {
	const ics = await (await download(t)).text();
	assert.match(ics, /RECURRENCE-ID;TZID=America\/Los_Angeles:20261116T090000\r\n/);
	const at = ics.indexOf("RECURRENCE-ID;TZID=America/Los_Angeles");
	const moved = ics.slice(at, ics.indexOf("END:VEVENT", at));
	assert.match(moved, /DTSTART;TZID=America\/Los_Angeles:20261116T110000/);
	assert.match(moved, /SUMMARY:Moved sync/);
	assert.match(moved, /DESCRIPTION:Weekly notes/); // A null override field inherits the series text.
	assert.match(moved, /LOCATION:Video/);
});

test("text escapes and every line folds under 75 octets", async (t) => {
	const ics = await (await download(t)).text();
	assert.match(ics, /SUMMARY:One\\, off\\; "quoted"\r\n/);
	assert.match(ics, /LOCATION:Room\\, 2\r\n/);
	for (const line of ics.split("\r\n")) {
		assert.ok(new TextEncoder().encode(line).length <= 75, line);
		assert.doesNotMatch(line, controlChars);
	}
});

test("an empty calendar still exports a valid file", async (t) => {
	await setup(t, { user: { id: "user-2", calendarEnabled: true } });
	const res = await app.route.GET(req());
	assert.equal(res.status, 200);
	const ics = await res.text();
	assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
	assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
	assert.doesNotMatch(ics, /BEGIN:VEVENT/);
});

test("a range bounds one-offs but a series always exports whole", async (t) => {
	const res = await download(t, req("/api/export/calendar?start=2026-12-01T00:00:00Z"));
	const ics = await res.text();
	assert.doesNotMatch(ics, /UID:evt-one@mailflare/);
	assert.match(ics, /UID:evt-weekly@mailflare\r\n/);
	assert.match(ics, /RRULE:FREQ=WEEKLY\r\n/); // The full series rule, never clipped to the range.
});

test("a range keeps a series whose only overlap is a moved occurrence", async (t) => {
	// evt-future's master starts in December, outside the window, but ov-3 moved one Tuesday into it.
	const res = await download(t, req("/api/export/calendar?start=2026-11-03T00:00:00Z&end=2026-11-04T00:00:00Z"));
	const ics = await res.text();
	assert.match(ics, /UID:evt-future@mailflare\r\n/);
	assert.match(ics, /RECURRENCE-ID:20261208T090000Z\r\n/);
	assert.match(ics, /DTSTART:20261103T090000Z\r\n/);
	assert.match(ics, /UID:evt-one@mailflare\r\n/); // The one-off inside the window still comes along.
});

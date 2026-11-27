import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = { "@/db": "export function getDb(){return globalThis.calPubLib.db}" };
const fixture = await loadFixture({ name: "cal-pub-lib", entryPoint: "src/lib/calendar/free-busy-publish.ts", mocks });
const { publishedBusy, publishWindow, buildFreeBusyIfb, buildFreeBusyIcs } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calPubLib; fixture.dispose(); });

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2030, 0, 15, 12));
const secs = (ms) => Math.floor(ms / 1000);
function setup() {
	sqlite?.close();
	sqlite = installSqlite("calPubLib", { schema });
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'User', 'x', 'user', 1)`);
}
function event(id, user, startMs, endMs, extra = "") {
	const cols = ["id", "user_id", "title", "starts_at", "ends_at", "created_at", "updated_at"];
	const vals = [`'${id}'`, `'${user}'`, "'Secret title'", secs(startMs), secs(endMs), 1, 1];
	for (const [key, value] of Object.entries(extra ? JSON.parse(extra) : {})) { cols.push(key); vals.push(typeof value === "string" ? `'${value}'` : value); }
	sqlite.exec(`INSERT INTO calendar_events (${cols.join(",")}) VALUES (${vals.join(",")})`);
}

test("the window is the past week and the next eight weeks: 63 days, which one service call (62 days at most) cannot cover", () => {
	const { start, end } = publishWindow(NOW);
	assert.equal(start.getTime(), NOW.getTime() - 7 * DAY);
	assert.equal(end.getTime(), NOW.getTime() + 56 * DAY);
	assert.ok(end.getTime() - start.getTime() > 62 * DAY);
});

test("busy times come from the free/busy service over the whole window, merged across the seam of the two calls", async () => {
	setup();
	const { start, end } = publishWindow(NOW);
	const mid = (start.getTime() + end.getTime()) / 2;
	event("early", "u1", start.getTime() + 3_600_000, start.getTime() + 7_200_000);
	event("seam", "u1", mid - 3_600_000, mid + 3_600_000); // spans the point where the window is cut
	event("late", "u1", end.getTime() - 7_200_000, end.getTime() - 3_600_000);
	event("outside", "u1", end.getTime() + DAY, end.getTime() + DAY + 3_600_000);
	event("other", "u2", NOW.getTime(), NOW.getTime() + 3_600_000);
	const busy = await publishedBusy({}, "u1", NOW);
	assert.deepEqual(busy, [
		[start.getTime() + 3_600_000, start.getTime() + 7_200_000],
		[mid - 3_600_000, mid + 3_600_000],
		[end.getTime() - 7_200_000, end.getTime() - 3_600_000],
	]);
});

test("a daily series runs through both halves of the window; free and private events are as CS-5 decides", async () => {
	setup();
	event("daily", "u1", NOW.getTime() - 10 * DAY, NOW.getTime() - 10 * DAY + 3_600_000, JSON.stringify({ repeat: "daily" }));
	event("free", "u1", NOW.getTime() + DAY + 3_600_000 * 5, NOW.getTime() + DAY + 3_600_000 * 6, JSON.stringify({ transparent: 1 }));
	event("private", "u1", NOW.getTime() + 2 * DAY + 7_200_000, NOW.getTime() + 2 * DAY + 10_800_000, JSON.stringify({ is_private: 1 }));
	const busy = await publishedBusy({}, "u1", NOW);
	const dayStart = (n) => NOW.getTime() - 10 * DAY + n * DAY;
	assert.ok(busy.some(([from]) => from === dayStart(11)), "an occurrence in the first half");
	assert.ok(busy.some(([from]) => from === dayStart(10 + 50)), "an occurrence in the second half");
	assert.ok(!busy.some(([from]) => from === NOW.getTime() + DAY + 3_600_000 * 5), "a free event is not busy");
	assert.ok(busy.some(([from, to]) => from === NOW.getTime() + 2 * DAY + 7_200_000 && to - from === 3_600_000), "a private event counts as busy");
});

test(".ifb is a VFREEBUSY with one FREEBUSY period per interval and nothing else about the person", () => {
	const body = buildFreeBusyIfb([[Date.UTC(2030, 0, 16, 9), Date.UTC(2030, 0, 16, 10)], [Date.UTC(2030, 0, 17, 9), Date.UTC(2030, 0, 17, 10)]], { uid: "abc123", now: NOW, start: new Date(NOW.getTime() - 7 * DAY), end: new Date(NOW.getTime() + 56 * DAY) });
	assert.ok(body.endsWith("\r\n"));
	assert.ok(!/[^\r]\n/.test(body), "only CRLF line breaks");
	assert.deepEqual(body.split("\r\n").slice(0, -1), [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Free Busy//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
		"BEGIN:VFREEBUSY", "UID:abc123@mailflare", "DTSTAMP:20300115T120000Z", "DTSTART:20300108T120000Z", "DTEND:20300312T120000Z",
		"FREEBUSY;FBTYPE=BUSY:20300116T090000Z/20300116T100000Z", "FREEBUSY;FBTYPE=BUSY:20300117T090000Z/20300117T100000Z",
		"END:VFREEBUSY", "END:VCALENDAR",
	]);
	assert.doesNotMatch(body, /ORGANIZER|ATTENDEE|SUMMARY|Secret/);
});

test(".ifb with nothing busy is still a valid VFREEBUSY", () => {
	const body = buildFreeBusyIfb([], { uid: "abc", now: NOW, start: NOW, end: new Date(NOW.getTime() + DAY) });
	assert.match(body, /BEGIN:VFREEBUSY\r\n/);
	assert.doesNotMatch(body, /FREEBUSY;/);
});

test("format=ics is one VEVENT per interval, SUMMARY Busy, opaque, with stable UIDs and no other detail", () => {
	const body = buildFreeBusyIcs([[Date.UTC(2030, 0, 16, 9), Date.UTC(2030, 0, 16, 10)]], { uid: "abc123", now: NOW });
	assert.deepEqual(body.split("\r\n").slice(0, -1), [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Free Busy//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Busy",
		"BEGIN:VEVENT", "UID:abc123-20300116T090000Z@mailflare", "DTSTAMP:20300115T120000Z", "DTSTART:20300116T090000Z", "DTEND:20300116T100000Z",
		"SUMMARY:Busy", "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR",
	]);
	assert.equal(buildFreeBusyIcs([[Date.UTC(2030, 0, 16, 9), Date.UTC(2030, 0, 16, 10)]], { uid: "abc123", now: new Date(NOW.getTime() + 5000) }).includes("UID:abc123-20300116T090000Z@mailflare"), true, "the UID does not depend on when it is fetched");
});

test("a UID that is hostile text is escaped, and long lines are folded at 75 octets", () => {
	const body = buildFreeBusyIcs([[0, 3_600_000]], { uid: "x\r\nATTENDEE:mailto:evil@x.test" + "y".repeat(100), now: NOW });
	assert.ok(!body.includes("\r\nATTENDEE:"), "no injected property line");
	for (const line of body.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-import-rows-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { u: join(root, "src/lib/calendar/import-store-utils.ts"), i: join(root, "src/lib/calendar/ics-import.ts"), s: join(root, "src/db/schema/index.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const { icsEventId, planGroupIds, candidateIds, planCalendarImportRows, readCalendarImportBody, ROWS_PER_INSERT, chunk } = await load("u");
const { parseIcsEventGroup } = await load("i");
const { calendarEvents } = await load("s");
const { drizzle } = await import("drizzle-orm/sqlite-proxy");

const options = { userZone: "UTC", ownAddresses: [], reminders: true, skipDeclined: true };
const group = (uid, ...extra) => parseIcsEventGroup(["BEGIN:VEVENT", `UID:${uid}`, "DTSTART:20261104T090000Z", "SUMMARY:S", ...extra, "END:VEVENT"].join("\r\n"), options);
const override = (uid, at) => ["BEGIN:VEVENT", `UID:${uid}`, `RECURRENCE-ID:${at}`, "DTSTART:20261105T100000Z", "SUMMARY:O", "END:VEVENT"].join("\r\n");
const planned = async (userId, groups) => Promise.all(groups.map(async (g) => ({ group: g, ids: await planGroupIds(userId, g) })));

test("ids are deterministic, per user, and distinguish occurrences", async () => {
	const a = await icsEventId("u1", "uid-1", null);
	assert.match(a, /^ics_[0-9a-f]{24}$/);
	assert.equal(a, await icsEventId("u1", "uid-1", null));
	assert.notEqual(a, await icsEventId("u2", "uid-1", null));
	assert.notEqual(a, await icsEventId("u1", "uid-1", 1000));
	assert.notEqual(await icsEventId("u1", "uid-1", 1000), await icsEventId("u1", "uid-1", 2000));
});

test("rows are plain events with no mailbox, invitation sender or response status", async () => {
	const g = group("a", "RRULE:FREQ=DAILY", "ATTENDEE:mailto:x@y.org");
	const plan = planCalendarImportRows(await planned("u1", [g]), new Set(), "u1", "#16a34a");
	assert.equal(plan.rows.length, 1);
	const [row] = plan.rows;
	assert.equal(row.userId, "u1");
	assert.equal(row.mailboxId, null);
	assert.equal(row.color, "#16a34a");
	assert.equal(row.repeat, "daily");
	assert.equal(row.attendees, JSON.stringify(["x@y.org"]));
	for (const key of ["inviteSender", "inviteMessageId", "responseStatus", "inviteSequence"]) assert.equal(key in row, false, key);
	assert.equal(plan.imported, 1);
});

test("an event already on the calendar is skipped, by import id, invitation id or Mailflare's own id", async () => {
	const g = group("a");
	const [entry] = await planned("u1", [g]);
	assert.equal(planCalendarImportRows([entry], new Set([entry.ids.masterId]), "u1", "#000").skipped, 1);
	assert.equal(planCalendarImportRows([entry], new Set([entry.ids.incId]), "u1", "#000").rows.length, 0);
	const own = group("evt_123@mailflare");
	const [ownEntry] = await planned("u1", [own]);
	assert.equal(ownEntry.ids.ownId, "evt_123");
	const skipped = planCalendarImportRows([ownEntry], new Set(["evt_123"]), "u1", "#000");
	assert.deepEqual([skipped.rows.length, skipped.skipped], [0, 1]);
	assert.equal(planCalendarImportRows([entry], new Set(), "u1", "#000").rows.length, 1);
	assert.ok(candidateIds([entry, ownEntry]).includes("evt_123"));
});

test("overrides are separate rows and a partial earlier run completes", async () => {
	const g = parseIcsEventGroup(["BEGIN:VEVENT", "UID:s", "DTSTART:20261104T090000Z", "RRULE:FREQ=DAILY", "SUMMARY:M", "END:VEVENT", override("s", "20261105T090000Z")].join("\r\n"), options);
	const [entry] = await planned("u1", [g]);
	assert.equal(entry.ids.overrideIds.length, 1);
	assert.equal(planCalendarImportRows([entry], new Set(), "u1", "#000").rows.length, 2);
	const again = planCalendarImportRows([entry], new Set([entry.ids.masterId]), "u1", "#000");
	assert.deepEqual([again.rows.length, again.skipped], [1, 1]);
	assert.equal(JSON.parse(planCalendarImportRows([entry], new Set(), "u1", "#000").rows[0].excludedOccurrences).length, 1);
});

test("duplicate groups in one request insert once; counts follow imported rows", async () => {
	const simple = parseIcsEventGroup(["BEGIN:VEVENT", "UID:y", "DTSTART:20261104T090000Z", "RRULE:FREQ=YEARLY", "SUMMARY:Y", "END:VEVENT"].join("\r\n"), options);
	const plan = planCalendarImportRows(await planned("u1", [group("a"), group("a"), simple]), new Set(), "u1", "#000");
	assert.equal(plan.rows.length, 2);
	assert.equal(plan.simplified, 1);
	assert.equal(planCalendarImportRows(await planned("u1", [simple]), new Set([(await planned("u1", [simple]))[0].ids.masterId]), "u1", "#000").simplified, 0);
});

test("an insert chunk stays under D1's 100 bound parameters", async () => {
	const full = group("a", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "ATTENDEE:mailto:x@y.org", "DESCRIPTION:d", "LOCATION:l", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT5M", "END:VALARM");
	const groups = Array.from({ length: 20 }, () => full);
	const plan = planCalendarImportRows(await planned("u1", groups.map((g, n) => ({ ...g, uid: `u${n}` }))), new Set(), "u1", "#000");
	const rows = Array.from({ length: ROWS_PER_INSERT }, (_, n) => ({ ...plan.rows[0], id: `ics_${n}` }));
	const db = drizzle(async () => ({ rows: [] }));
	const query = db.insert(calendarEvents).values(rows).onConflictDoNothing().toSQL();
	assert.ok(query.params.length < 100, `${query.params.length} params`);
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("the request body is validated", () => {
	const ok = readCalendarImportBody({ source: { name: "Work", color: "#16a34a", googleAddress: "Me@Gmail.com" }, options: { reminders: false }, groups: ["BEGIN:VEVENT"] });
	assert.deepEqual(ok, { value: { name: "Work", color: "#16a34a", googleAddress: "me@gmail.com", reminders: false, skipDeclined: true, groups: ["BEGIN:VEVENT"] } });
	assert.equal(readCalendarImportBody({ source: { name: "x" }, groups: ["g"] }).value.reminders, true);
	assert.equal(readCalendarImportBody({ source: { name: "x", googleAddress: "not an address" }, groups: ["g"] }).value.googleAddress, undefined);
	const bad = [null, [], {}, { source: {}, groups: ["g"] }, { source: { name: "x".repeat(121) }, groups: ["g"] }, { source: { name: "x" }, groups: [] },
		{ source: { name: "x" }, groups: "g" }, { source: { name: "x" }, groups: [1] }, { source: { name: "x" }, groups: Array(51).fill("g") },
		{ source: { name: "x" }, groups: ["x".repeat(512 * 1024 + 1)] }, { source: { name: "x" }, options: { reminders: "yes" }, groups: ["g"] }];
	for (const body of bad) assert.ok(readCalendarImportBody(body).error, JSON.stringify(body)?.slice(0, 60));
});

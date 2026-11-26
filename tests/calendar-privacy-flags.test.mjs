import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-privacy-flags-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: {
		invite: join(root, "src/lib/calendar/invite.ts"),
		store: join(root, "src/lib/calendar/invite-store.ts"),
		feed: join(root, "src/lib/calendar/feed.ts"),
		utils: join(root, "src/lib/calendar/utils.ts"),
	},
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@": join(root, "src") },
	external: ["better-sqlite3", "pg", "postgres", "mysql2", "@neondatabase/serverless", "@planetscale/database", "@libsql/client", "@electric-sql/pglite", "bun:sqlite", "cloudflare:workers"],
});
const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
const { parseInvite } = await load("invite");
const { inviteEventValues, inviteEventFlags } = await load("store");
const { buildCalendarFeed, buildVevent } = await load("feed");
const { createCalendarInvitation } = await load("utils");

const invite = (...lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:x", "DTSTART:20261104T170000Z", "DTEND:20261104T180000Z", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const base = { id: "evt_1", title: "T", description: "", location: "", repeat: "none", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", timeZone: null, attendees: "[]", startsAt: new Date("2026-11-02T17:00:00Z"), endsAt: new Date("2026-11-02T17:30:00Z") };
const stamp = "20261101T000000Z";

test("an invitation without CLASS and TRANSP is public and busy", () => {
	const parsed = parseInvite(invite());
	assert.equal(parsed.isPrivate, false);
	assert.equal(parsed.transparent, false);
});

test("CLASS:PRIVATE and CLASS:CONFIDENTIAL are private, CLASS:PUBLIC is not, in any case", () => {
	for (const [value, expected] of [["PRIVATE", true], ["confidential", true], ["Private", true], ["PUBLIC", false], ["X-OTHER", false]]) {
		assert.equal(parseInvite(invite(`CLASS:${value}`)).isPrivate, expected, value);
	}
});

test("TRANSP:TRANSPARENT is free, TRANSP:OPAQUE is busy", () => {
	assert.equal(parseInvite(invite("TRANSP:TRANSPARENT")).transparent, true);
	assert.equal(parseInvite(invite("transp:transparent")).transparent, true);
	assert.equal(parseInvite(invite("TRANSP:OPAQUE")).transparent, false);
});

test("an invitation's flags are set for a new event only; a refresh never carries them", () => {
	const common = { title: "T", description: "", location: "", sequence: 1, rrule: null, startsAt: new Date("2026-11-04T17:00:00Z"), endsAt: new Date("2026-11-04T18:00:00Z"), excludedDates: [] };
	assert.deepEqual(inviteEventFlags({ ...common, isPrivate: true, transparent: true }), { isPrivate: true, transparent: true });
	assert.deepEqual(inviteEventFlags(common), { isPrivate: false, transparent: false });
	const refresh = inviteEventValues({ ...common, isPrivate: true, transparent: true }, "UTC", "[]");
	assert.ok(!("isPrivate" in refresh) && !("transparent" in refresh), "the attendee's own choice survives an organiser update");
});

test("the VEVENT builder writes CLASS:PRIVATE and TRANSP:TRANSPARENT only when set", () => {
	const plain = buildVevent(base, { stamp });
	assert.ok(!plain.some((line) => line.startsWith("CLASS") || line.startsWith("TRANSP")), "an ordinary event renders exactly as before");
	const flagged = buildVevent({ ...base, isPrivate: true, transparent: true }, { stamp });
	assert.ok(flagged.includes("CLASS:PRIVATE"));
	assert.ok(flagged.includes("TRANSP:TRANSPARENT"));
	assert.ok(!flagged.includes("TRANSP:OPAQUE"));
});

test("the subscription feed carries the flags", () => {
	const feed = buildCalendarFeed([{ ...base, isPrivate: true }, { ...base, id: "evt_2", transparent: true }], { name: "M", now: new Date("2026-11-01T00:00:00Z") });
	assert.equal(feed.match(/CLASS:PRIVATE/g)?.length, 1);
	assert.equal(feed.match(/TRANSP:TRANSPARENT/g)?.length, 1);
});

test("an emailed invitation carries the flags, and parses back to them", () => {
	const text = (flags) => new TextDecoder().decode(createCalendarInvitation({ title: "T", description: "", location: "", startsAt: base.startsAt, endsAt: base.endsAt, uid: "evt_1", organizer: "a@b.co", attendees: ["c@d.co"], ...flags }));
	assert.doesNotMatch(text({}), /CLASS:|TRANSP:/);
	const sent = text({ isPrivate: true, transparent: true });
	assert.match(sent, /CLASS:PRIVATE/);
	assert.match(sent, /TRANSP:TRANSPARENT/);
	const parsed = parseInvite(sent);
	assert.equal(parsed.isPrivate, true);
	assert.equal(parsed.transparent, true);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-calendar-feed-month-end-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { buildCalendarFeed } from "./src/lib/calendar/feed.ts"; export { expandCalendarEvents } from "./src/app/(calendar)/calendar/utils.ts";`,
		resolveDir: root,
		sourcefile: "calendar-feed-month-end-entry.ts",
	},
	outfile: join(dir, "entry.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { buildCalendarFeed, expandCalendarEvents } = await import(pathToFileURL(join(dir, "entry.mjs")).href);

// The days a FREQ=MONTHLY rule picks in one month (RFC 5545 3.3.10: invalid dates are dropped, then BYSETPOS applies).
function ruleDays(rule, year, month) {
	const parts = Object.fromEntries(rule.replace(/^RRULE:/, "").split(";").map((part) => part.split("=")));
	const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const days = parts.BYMONTHDAY.split(",").map(Number).filter((day) => day >= 1 && day <= last).sort((a, b) => a - b);
	return parts.BYSETPOS ? parts.BYSETPOS.split(",").map((index) => days.at(Number(index) > 0 ? Number(index) - 1 : Number(index))).filter(Boolean) : days;
}

const event = (startsAt, repeatAnchorDay) => ({ id: "evt_1", title: "Rent", description: "", location: "", repeat: "monthly", repeatDays: "[]", repeatAnchorDay, repeatUntil: null, excludedOccurrences: "[]", timeZone: null, attendees: "[]", startsAt: new Date(startsAt), endsAt: new Date(new Date(startsAt).getTime() + 3_600_000) });

for (const [startsAt, anchor] of [["2026-01-31T09:00:00Z", 31], ["2026-01-30T09:00:00Z", 30], ["2026-01-29T09:00:00Z", 29], ["2026-01-31T09:00:00Z", null], ["2026-01-15T09:00:00Z", 15]]) {
	test(`a monthly event from ${startsAt.slice(0, 10)} (anchor ${anchor}) lands on the same days in the feed as in the app`, () => {
		const feedEvent = event(startsAt, anchor);
		const rule = buildCalendarFeed([feedEvent], { name: "M" }).split("\r\n").find((line) => line.startsWith("RRULE:"));
		const app = expandCalendarEvents([{ ...feedEvent, startsAt: feedEvent.startsAt.toISOString(), endsAt: feedEvent.endsAt.toISOString() }], new Date("2026-01-01T00:00:00Z"), new Date("2028-01-01T00:00:00Z"));
		const appDays = app.map((occurrence) => occurrence.startsAt.slice(0, 10));
		const feedDays = [];
		for (let index = 0; index < 24; index++) {
			const year = 2026 + Math.floor(index / 12);
			for (const day of ruleDays(rule, year, index % 12)) feedDays.push(new Date(Date.UTC(year, index % 12, day)).toISOString().slice(0, 10));
		}
		assert.deepEqual(feedDays, appDays, rule);
	});
}

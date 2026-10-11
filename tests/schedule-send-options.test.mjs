import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The quick picks are computed in the user's time zone. Pin it for the whole run.
process.env.TZ = "America/Los_Angeles";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-schedule-send-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/compose/schedule-send-utils.ts")],
	outfile: join(outDir, "schedule.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const schedule = await import(pathToFileURL(join(outDir, "schedule.mjs")).href);

const pacific = (date) => new Intl.DateTimeFormat("en-US", {
	timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}).format(date);

test("quick picks are tomorrow 8 AM, tomorrow 1 PM and next Monday 8 AM", () => {
	// Saturday, Oct 10, 2026, 9:30 PM in Los Angeles.
	const options = schedule.getQuickScheduleOptions(new Date("2026-10-11T04:30:00Z"));
	assert.deepEqual(options.map((option) => option.id), ["tomorrowMorning", "tomorrowAfternoon", "mondayMorning"]);
	assert.deepEqual(options.map((option) => pacific(option.value)), [
		"Sun, Oct 11, 8:00 AM",
		"Sun, Oct 11, 1:00 PM",
		"Mon, Oct 12, 8:00 AM",
	]);
});

test("when tomorrow is Monday, Monday morning is the following week", () => {
	// Sunday, Oct 11, 2026, 10:00 AM in Los Angeles.
	const options = schedule.getQuickScheduleOptions(new Date("2026-10-11T17:00:00Z"));
	assert.equal(pacific(options[0].value), "Mon, Oct 12, 8:00 AM");
	assert.equal(pacific(options[2].value), "Mon, Oct 19, 8:00 AM");
});

test("quick picks follow daylight saving changes", () => {
	// Saturday, Oct 31, 2026: clocks fall back overnight, so Sunday 8 AM is PST.
	const options = schedule.getQuickScheduleOptions(new Date("2026-10-31T19:00:00Z"));
	assert.equal(options[0].value.toISOString(), "2026-11-01T16:00:00.000Z");
});

test("custom times must be at least a minute ahead", () => {
	const now = new Date("2026-10-11T04:30:00Z");
	assert.equal(schedule.isSchedulableTime(new Date(now.getTime() + 30_000), now), false);
	assert.equal(schedule.isSchedulableTime(new Date(now.getTime() + 5 * 60_000), now), true);
});

test("the time zone note names the zone", () => {
	assert.match(schedule.getTimeZoneLongName(new Date("2026-10-11T04:30:00Z")), /Pacific Daylight Time/);
	assert.match(schedule.getTimeZoneLongName(new Date("2026-12-11T04:30:00Z")), /Pacific Standard Time/);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-calendar-reminders-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { utils: join(root, "src/lib/calendar/reminder-utils.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { normalizeReminderMinutes, formatReminderBody, REMINDER_MINUTE_OPTIONS } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

test("reminder offsets accept whole minutes in range and nothing else", () => {
	for (const minutes of REMINDER_MINUTE_OPTIONS) assert.equal(normalizeReminderMinutes(minutes), minutes);
	for (const bad of [-1, 1.5, 10081, "15", null, undefined, NaN]) assert.equal(normalizeReminderMinutes(bad), null, String(bad));
});

test("reminder body shows the start in the event zone and the location when set", () => {
	const start = new Date("2026-11-02T14:30:00Z");
	assert.equal(formatReminderBody(start, "America/New_York", ""), "Mon, Nov 2, 9:30 AM");
	assert.equal(formatReminderBody(start, "America/New_York", " Room 4 "), "Mon, Nov 2, 9:30 AM · Room 4");
	assert.match(formatReminderBody(start, "Not/AZone", ""), /2026-11-02/);
});

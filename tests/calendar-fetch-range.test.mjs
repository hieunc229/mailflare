import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-calendar-fetch-range-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	stdin: { contents: `export { calendarFetchRange, monthGridDates, startOfWeek } from "./src/app/(calendar)/calendar/utils.ts";`, resolveDir: root, sourcefile: "calendar-fetch-range-entry.ts" },
	outfile: join(dir, "entry.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { calendarFetchRange, monthGridDates, startOfWeek } = await import(pathToFileURL(join(dir, "entry.mjs")).href);

const DAY = 86_400_000;
const range = (today, visible, month) => calendarFetchRange(today, startOfWeek(visible), visible, month ? monthGridDates(visible) : null);

test("the fetched range stays under the API's 400 days however far the user pages", () => {
	const today = new Date("2026-11-28T00:00:00Z");
	for (const months of [-24, -12, -10, 0, 6, 10, 11, 12, 24]) {
		const visible = new Date(today.getTime() + months * 30 * DAY);
		for (const month of [true, false]) {
			const { start, end } = range(today, visible, month);
			assert.ok(end - start <= 400 * DAY, `${months} months, month view ${month}: ${(end - start) / DAY} days`);
			assert.ok(start <= visible && end > visible, "the visible day is covered");
		}
	}
});

test("near today the range still includes the next 90 days", () => {
	const today = new Date("2026-11-28T00:00:00Z");
	const { start, end } = range(today, today, true);
	assert.ok(start <= today && end >= new Date(today.getTime() + 90 * DAY));
});

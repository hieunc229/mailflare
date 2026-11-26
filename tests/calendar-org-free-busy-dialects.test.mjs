import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const journal = (directory) => JSON.parse(read(`${directory}/meta/_journal.json`)).entries;
const DIALECTS = [
	["sqlite", "drizzle/migrations", "0106_calendar_org_free_busy", "bundle.json", /`calendar_org_free_busy` integer DEFAULT 0 NOT NULL/],
	["postgres", "drizzle/migrations-pg", "0030_calendar_org_free_busy", "bundle-postgres.json", /"calendar_org_free_busy" boolean DEFAULT false NOT NULL/],
	["mysql", "drizzle/migrations-mysql", "0030_calendar_org_free_busy", "bundle-mysql.json", /`calendar_org_free_busy` boolean NOT NULL DEFAULT false/],
];

for (const [dialect, directory, tag, bundle, pattern] of DIALECTS) {
	test(`${dialect}: app_settings.calendar_org_free_busy is added off by default, journalled in order and bundled`, () => {
		const entries = journal(directory);
		const index = entries.findIndex((entry) => entry.tag === tag);
		assert.ok(index > 0, "journalled");
		assert.equal(entries[index].idx, entries[index - 1].idx + 1);
		assert.ok(entries[index].when > entries[index - 1].when, "journal timestamps stay increasing");
		assert.match(read(`${directory}/${tag}.sql`), pattern);
		const bundled = JSON.parse(read(`src/lib/migrations/${bundle}`)).migrations.find((migration) => migration.name === `${tag}.sql`);
		assert.ok(bundled, "the bundle carries the migration");
		assert.match(JSON.stringify(bundled), /calendar_org_free_busy/);
	});
}

test("the schema declares the column once, defaulting to off", () => {
	assert.match(read("src/db/schema/index.ts"), /calendarOrgFreeBusy: bool\("calendar_org_free_busy"\)\.notNull\(\)\.default\(false\)/);
});

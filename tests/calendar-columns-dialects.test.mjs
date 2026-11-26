import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const journal = (directory) => JSON.parse(read(`${directory}/meta/_journal.json`)).entries;
const DIALECTS = [
	["sqlite", "drizzle/migrations", "0106_calendar_columns"],
	["postgres", "drizzle/migrations-pg", "0030_calendar_columns"],
	["mysql", "drizzle/migrations-mysql", "0030_calendar_columns"],
];

for (const [dialect, directory, tag] of DIALECTS) {
	test(`${dialect}: the calendar columns migration exists, is journalled last, and is bundled`, () => {
		const entries = journal(directory);
		assert.equal(entries.at(-1).tag, tag);
		assert.equal(entries.at(-1).idx, entries.at(-2).idx + 1);
		assert.ok(entries.at(-1).when > entries.at(-2).when, "journal timestamps stay increasing");
		const sql = read(`${directory}/${tag}.sql`);
		for (const needle of ["calendar_id", "is_private", "transparent", "calendar_shares", "calendar_resources", "calendar_resource_bookings", "grantee_user_id"]) assert.match(sql, new RegExp(needle), needle);
		assert.doesNotMatch(sql, /grantee_group_id/, "D-3: the group column is the groups PR's");
	});

	test(`${dialect}: the change-log triggers resolve the collection from calendar_id`, () => {
		const sql = read(`${directory}/${tag}.sql`);
		assert.match(sql, /COALESCE\((NEW|OLD)\.calendar_id, /i);
		assert.match(sql, /is_private/);
		assert.doesNotMatch(sql.replace(/COALESCE\([^)]*\)/gi, ""), /'cal:' \|\| (NEW|OLD)\.user_id|CONCAT\('cal:', (NEW|OLD)\.user_id\)/, "no trigger keeps the old user-keyed collection");
	});
}

test("D-1: no migration backfills calendar_id", () => {
	for (const [, directory, tag] of DIALECTS) assert.doesNotMatch(read(`${directory}/${tag}.sql`), /UPDATE\s+[`"]?calendar_events/i);
});

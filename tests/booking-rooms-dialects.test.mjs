import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const journal = (directory) => JSON.parse(read(`${directory}/meta/_journal.json`)).entries;
const DIALECTS = [
	["sqlite", "drizzle/migrations", "0109_booking_event_resources", "0107_calendar_room_booking_guard", "bundle.json", /ALTER TABLE `booking_events` ADD `resource_ids` text DEFAULT '\[\]' NOT NULL[\s\S]*ALTER TABLE `calendar_resources` ADD `public_booking` integer DEFAULT false NOT NULL/],
	["postgres", "drizzle/migrations-pg", "0033_booking_event_resources", "0031_calendar_room_booking_guard", "bundle-postgres.json", /ALTER TABLE "booking_events" ADD COLUMN "resource_ids" text DEFAULT '\[\]' NOT NULL[\s\S]*ALTER TABLE "calendar_resources" ADD COLUMN "public_booking" boolean DEFAULT false NOT NULL/],
	["mysql", "drizzle/migrations-mysql", "0033_booking_event_resources", "0031_calendar_room_booking_guard", "bundle-mysql.json", /ALTER TABLE `booking_events` ADD `resource_ids` longtext NOT NULL DEFAULT \('\[\]'\)[\s\S]*ALTER TABLE `calendar_resources` ADD `public_booking` boolean NOT NULL DEFAULT false/],
];

for (const [dialect, directory, tag, previous, bundle, pattern] of DIALECTS) {
	test(`${dialect}: booking_events.resource_ids is added right after the room booking guard, journalled in order and bundled`, () => {
		const entries = journal(directory);
		const index = entries.findIndex((entry) => entry.tag === tag);
		assert.ok(index > 0, "journalled");
		assert.equal(entries[index - 1].tag, previous, "numbered straight after CS-7's migration");
		assert.equal(entries[index].idx, entries[index - 1].idx + 1);
		assert.ok(entries[index].when > entries[index - 1].when, "journal timestamps stay increasing");
		assert.match(read(`${directory}/${tag}.sql`), pattern);
		const bundled = JSON.parse(read(`src/lib/migrations/${bundle}`)).migrations.find((migration) => migration.name === `${tag}.sql`);
		assert.ok(bundled, "the bundle carries the migration");
		assert.match(JSON.stringify(bundled), /resource_ids/);
		assert.match(JSON.stringify(bundled), /public_booking/);
	});
}

test("the schema declares the columns once: a JSON list that defaults to no rooms, and a switch that defaults to off", () => {
	assert.match(read("src/db/schema/index.ts"), /resourceIds: text\("resource_ids"\)\.notNull\(\)\.default\("\[\]"\)/);
	assert.match(read("src/db/schema/index.ts"), /publicBooking: bool\("public_booking"\)\.notNull\(\)\.default\(false\)/);
});

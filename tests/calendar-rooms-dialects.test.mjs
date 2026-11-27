import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const journal = (directory) => JSON.parse(read(`${directory}/meta/_journal.json`)).entries;
const DIALECTS = [
	["sqlite", "drizzle/migrations", "0107_calendar_room_booking_guard", "bundle.json", [/ALTER TABLE `calendar_resources` ADD `booking_token` text DEFAULT '' NOT NULL/, /ALTER TABLE `calendar_resource_bookings` ADD `conflict_at` integer/]],
	["postgres", "drizzle/migrations-pg", "0031_calendar_room_booking_guard", "bundle-postgres.json", [/ALTER TABLE "calendar_resources" ADD COLUMN "booking_token" text DEFAULT '' NOT NULL/, /ALTER TABLE "calendar_resource_bookings" ADD COLUMN "conflict_at" bigint/]],
	["mysql", "drizzle/migrations-mysql", "0031_calendar_room_booking_guard", "bundle-mysql.json", [/ALTER TABLE `calendar_resources` ADD `booking_token` longtext NOT NULL DEFAULT \(''\)/, /ALTER TABLE `calendar_resource_bookings` ADD `conflict_at` bigint/]],
];

for (const [dialect, directory, tag, bundle, patterns] of DIALECTS) {
	test(`${dialect}: the room booking guard columns are added, journalled in order and bundled`, () => {
		const entries = journal(directory);
		const index = entries.findIndex((entry) => entry.tag === tag);
		assert.ok(index > 0, "journalled");
		assert.equal(index, entries.length - 1, "last in the journal");
		assert.equal(entries[index].idx, entries[index - 1].idx + 1);
		assert.ok(entries[index].when > entries[index - 1].when, "journal timestamps stay increasing");
		for (const pattern of patterns) assert.match(read(`${directory}/${tag}.sql`), pattern);
		const bundled = JSON.parse(read(`src/lib/migrations/${bundle}`)).migrations.find((migration) => migration.name === `${tag}.sql`);
		assert.ok(bundled, "the bundle carries the migration");
		assert.match(JSON.stringify(bundled), /booking_token/);
		assert.match(JSON.stringify(bundled), /conflict_at/);
	});
}

test("the schema declares both columns once", () => {
	const schema = read("src/db/schema/index.ts");
	assert.match(schema, /bookingToken: text\("booking_token"\)\.notNull\(\)\.default\(""\)/);
	assert.match(schema, /conflictAt: timestamp\("conflict_at"\)/);
});

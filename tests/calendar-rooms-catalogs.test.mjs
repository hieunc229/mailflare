import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const catalogs = [["en", read("src/lib/i18n/en.json")], ...readdirSync(new URL("../public/locales", import.meta.url)).filter((file) => file.endsWith(".json")).map((file) => [file, read(`public/locales/${file}`)])];
const en = catalogs[0][1];
const mine = Object.keys(en).filter((key) => key.startsWith("calendar.rooms.") || key.startsWith("rooms.") || key === "admin.nav.rooms");

test("every catalog (34) carries every rooms string, non-empty", () => {
	assert.equal(catalogs.length, 34);
	assert.ok(mine.length >= 55, `found ${mine.length} keys`);
	for (const [name, catalog] of catalogs) for (const key of mine) assert.ok(typeof catalog[key] === "string" && catalog[key].trim(), `${name}: ${key}`);
});

test("the placeholders of each string are the same in every catalog", () => {
	const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join();
	for (const [name, catalog] of catalogs) for (const key of mine) assert.equal(names(catalog[key]), names(en[key]), `${name}: ${key}`);
});

test("every rooms string the new screens ask for exists in English", () => {
	const files = ["src/app/(admin)/rooms/page.tsx", "src/app/(admin)/rooms/rooms-view.tsx", "src/app/(admin)/rooms/room-dialog.tsx", "src/app/(admin)/rooms/utils.ts", "src/app/(calendar)/calendar/rooms-picker.tsx", "src/app/(calendar)/calendar/room-list.tsx", "src/app/(calendar)/calendar/room-utils.ts", "src/app/(calendar)/calendar/event-view-dialog.tsx", "src/app/(calendar)/calendar/page.tsx"];
	const used = new Set();
	for (const file of files) for (const match of readFileSync(new URL(`../${file}`, import.meta.url), "utf8").matchAll(/["'`]((?:calendar\.rooms|rooms)\.[A-Za-z.]+)["'`]/g)) used.add(match[1]);
	assert.ok(used.size >= 40, `found ${used.size} keys in use`);
	for (const key of used) assert.ok(key in en, key);
});

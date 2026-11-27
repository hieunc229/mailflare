import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const catalogs = [["en", read("src/lib/i18n/en.json")], ...readdirSync(new URL("../public/locales", import.meta.url)).filter((file) => file.endsWith(".json")).map((file) => [file, read(`public/locales/${file}`)])];
const en = catalogs[0][1];
const mine = Object.keys(en).filter((key) => key === "calendar.publish" || key.startsWith("calendar.publish."));

test("the publish card has its strings, in English, in every one of the 34 catalogs", () => {
	assert.equal(catalogs.length, 34);
	assert.ok(mine.length >= 20, `found ${mine.length} keys`);
	for (const [name, catalog] of catalogs) for (const key of mine) assert.ok(typeof catalog[key] === "string" && catalog[key].trim(), `${name}: ${key}`);
	for (const [name, catalog] of catalogs) for (const key of mine) assert.equal(catalog[key], en[key], `${name}: ${key} is the English text`);
});

test("the placeholders of each string are the same in every catalog", () => {
	const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join();
	for (const [name, catalog] of catalogs) for (const key of mine) assert.equal(names(catalog[key]), names(en[key]), `${name}: ${key}`);
});

test("the copy says what is shared, what is not, and that the link cannot be shown again", () => {
	const text = mine.map((key) => en[key]).join(" ");
	for (const needle of ["busy", "private events", "titles", "turn it off", "cannot be shown again"]) assert.ok(text.toLowerCase().includes(needle), needle);
});

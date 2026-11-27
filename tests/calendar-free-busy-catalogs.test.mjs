import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const catalogs = [["en", read("src/lib/i18n/en.json")], ...readdirSync(new URL("../public/locales", import.meta.url)).filter((file) => file.endsWith(".json")).map((file) => [file, read(`public/locales/${file}`)])];
const en = catalogs[0][1];
const mine = Object.keys(en).filter((key) => key.startsWith("calendar.availability.") || key.startsWith("general.orgFreeBusy"));

test("every catalog (34) carries every free/busy string, non-empty", () => {
	assert.equal(catalogs.length, 34);
	assert.ok(mine.length >= 25, `found ${mine.length} keys`);
	for (const [name, catalog] of catalogs) for (const key of mine) assert.ok(typeof catalog[key] === "string" && catalog[key].trim(), `${name}: ${key}`);
});

test("the placeholders of each string are the same in every catalog", () => {
	const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join();
	for (const [name, catalog] of catalogs) for (const key of mine) assert.equal(names(catalog[key]), names(en[key]), `${name}: ${key}`);
});

test("the admin hint says plainly who can see what, in every catalog", () => {
	for (const [name, catalog] of catalogs) {
		const hint = catalog["general.orgFreeBusyHint"];
		for (const needle of ["every account on this installation", "all domains", "API key with the calendar:read scope", "busy times", "by email address", "never titles or details", "Team licence"]) assert.ok(hint.includes(needle), `${name}: missing "${needle}"`);
	}
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-vtimezone-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/calendar/vtimezone.ts")], outfile: join(dir, "v.mjs"), bundle: true, platform: "node", format: "esm", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { buildVtimezone } = await import(pathToFileURL(join(dir, "v.mjs")).href);

const dates = (lines) => lines.filter((line) => line.startsWith("RDATE:")).flatMap((line) => line.slice(6).split(","));

test("a zone with daylight saving lists every transition of the window as a local RDATE", () => {
	// Window for a current year of 2026: 2025 through 2036.
	const lines = buildVtimezone("America/Los_Angeles", 2026, 2026);
	const text = lines.join("\n");
	assert.equal(lines[0], "BEGIN:VTIMEZONE");
	assert.equal(lines[1], "TZID:America/Los_Angeles");
	assert.equal(lines.at(-1), "END:VTIMEZONE");
	// 2026: DST starts 8 March 02:00 PST (-0800 to -0700), ends 1 November 02:00 PDT (-0700 to -0800).
	assert.match(text, /BEGIN:DAYLIGHT\nDTSTART:20250309T020000\nTZOFFSETFROM:-0800\nTZOFFSETTO:-0700\nRDATE:20250309T020000,20260308T020000,20270314T020000,20280312T020000,/);
	assert.match(text, /BEGIN:STANDARD\nDTSTART:20251102T020000\nTZOFFSETFROM:-0700\nTZOFFSETTO:-0800\nRDATE:20251102T020000,20261101T020000,20271107T020000,20281105T020000,/);
	assert.equal(dates(lines).length, 24);
	assert.ok(dates(lines).at(-1).startsWith("2036"));
	// Before the first transition of the window the zone is on standard time.
	assert.match(text, /BEGIN:STANDARD\nDTSTART:19000101T000000\nTZOFFSETFROM:-0800\nTZOFFSETTO:-0800\nEND:STANDARD/);
});

test("Europe/Berlin uses +0100 and +0200", () => {
	const text = buildVtimezone("Europe/Berlin", 2026, 2026).join("\n");
	assert.match(text, /TZOFFSETFROM:\+0100\nTZOFFSETTO:\+0200\nRDATE:20250330T020000,20260329T020000/);
	assert.match(text, /TZOFFSETFROM:\+0200\nTZOFFSETTO:\+0100\nRDATE:20251026T030000,20261025T030000/);
});

test("a series that started before the window gets its start-year transitions and the window's, not the years between", () => {
	const lines = buildVtimezone("Europe/Berlin", 2004, 2026);
	const all = dates(lines);
	// 2004: last Sunday of March (28th) and October (31st); the window then starts with 2025.
	for (const wanted of ["20040328T020000", "20041031T030000", "20250330T020000", "20251026T030000", "20360330T020000"]) assert.ok(all.includes(wanted), `${wanted} in ${all.join(",")}`);
	assert.ok(!all.some((value) => value.startsWith("2010")));
	// The base observance is the offset at the start of 2004.
	assert.match(lines.join("\n"), /DTSTART:19000101T000000\nTZOFFSETFROM:\+0100\nTZOFFSETTO:\+0100/);
});

test("a series that starts after the window gets its own year too", () => {
	const all = dates(buildVtimezone("Europe/Berlin", 2040, 2026));
	assert.ok(all.includes("20400325T020000") && all.includes("20360330T020000"));
});

test("a zone without daylight saving has the one base observance", () => {
	const lines = buildVtimezone("Asia/Kolkata", 2026, 2026);
	assert.deepEqual(lines.filter((line) => line.startsWith("BEGIN:")), ["BEGIN:VTIMEZONE", "BEGIN:STANDARD"]);
	assert.ok(lines.includes("TZOFFSETTO:+0530"));
});

test("the result is cached, the start year is clamped, and an unknown zone throws", () => {
	assert.equal(buildVtimezone("Europe/Berlin", 2026, 2026), buildVtimezone("Europe/Berlin", 2026, 2026));
	assert.deepEqual(buildVtimezone("Europe/Berlin", 1800, 2026), buildVtimezone("Europe/Berlin", 1970, 2026));
	assert.throws(() => buildVtimezone("Not/AZone", 2026, 2026));
});

test("after warm-up five zones cost well under 10 ms of CPU, cold or not", () => {
	const zones = ["Europe/Berlin", "America/New_York", "Asia/Tokyo", "Australia/Sydney", "America/Sao_Paulo"];
	const year = new Date().getUTCFullYear();
	const cold = process.cpuUsage();
	for (const zone of zones) buildVtimezone(zone, 2004, year);
	const coldMs = process.cpuUsage(cold);
	const warm = process.cpuUsage();
	for (const zone of zones) buildVtimezone(zone, 2004, year);
	for (const zone of zones) buildVtimezone(zone, 2019, year);
	const warmMs = process.cpuUsage(warm);
	console.log(`vtimezone cpu: cold 5 zones ${(coldMs.user + coldMs.system) / 1000} ms, warm ${(warmMs.user + warmMs.system) / 1000} ms`);
	assert.ok((warmMs.user + warmMs.system) / 1000 < 10);
});

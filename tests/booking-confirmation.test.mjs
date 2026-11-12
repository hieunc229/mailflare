import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-booking-confirmation-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { c: join(root, "src/lib/booking/confirmation-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { buildBookingConfirmation, formatBookingWhen, pickConfirmationLanguage } = await import(pathToFileURL(join(dir, "c.mjs")).href);

const startsAt = new Date("2026-11-17T13:00:00Z");
const endsAt = new Date("2026-11-17T13:30:00Z");

test("formats the slot in the event's time zone", () => {
	assert.equal(formatBookingWhen(startsAt, endsAt, "Europe/Berlin"), "Tuesday, 17 November 2026, 14:00–14:30 (Europe/Berlin)");
});

test("falls back to UTC for an unknown time zone", () => {
	assert.equal(formatBookingWhen(startsAt, endsAt, "Not/AZone"), "Tuesday, 17 November 2026, 13:00–13:30 (UTC)");
});

test("builds subject and body, leaving out empty location and notes", () => {
	const base = { eventName: "Intro call", hostName: "Paul", guestName: "Ana", location: "", notes: "", startsAt, endsAt, timeZone: "Europe/Berlin" };
	const plain = buildBookingConfirmation(base);
	assert.equal(plain.subject, "Confirmed: Intro call with Paul");
	assert.match(plain.text, /^Hi Ana,/);
	assert.match(plain.text, /When: Tuesday, 17 November 2026, 14:00–14:30 \(Europe\/Berlin\)/);
	assert.doesNotMatch(plain.text, /Where:|Your notes:/);
	const full = buildBookingConfirmation({ ...base, location: "https://meet.example/abc", notes: "About pricing" });
	assert.match(full.text, /Where: https:\/\/meet\.example\/abc/);
	assert.match(full.text, /Your notes:\nAbout pricing/);
});

test("writes German for German guests", () => {
	assert.equal(formatBookingWhen(startsAt, endsAt, "Europe/Berlin", "de"), "Dienstag, 17. November 2026, 14:00–14:30 Uhr (Europe/Berlin)");
	const mail = buildBookingConfirmation({ eventName: "Beratung", hostName: "Paul", guestName: "Ana", location: "Telefon", notes: "", startsAt, endsAt, timeZone: "Europe/Berlin" }, "de");
	assert.equal(mail.subject, "Bestätigt: Beratung mit Paul");
	assert.match(mail.text, /^Guten Tag Ana,\n\nIhre Buchung ist bestätigt: Beratung mit Paul\./);
	assert.match(mail.text, /Wo: Telefon/);
});

test("picks the booking page language, then the browser's, then English", () => {
	assert.equal(pickConfirmationLanguage("de", "en-US,en;q=0.9"), "de");
	assert.equal(pickConfirmationLanguage("en", "de-DE,de;q=0.9"), "en");
	assert.equal(pickConfirmationLanguage(null, "fr-FR,de;q=0.8,en;q=0.5"), "de");
	assert.equal(pickConfirmationLanguage("pt-BR", "ja"), "en");
	assert.equal(pickConfirmationLanguage(undefined, undefined), "en");
});

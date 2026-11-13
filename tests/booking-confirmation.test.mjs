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
const { buildBookingCalendarFile, buildBookingConfirmation, formatBookingWhen, parseConfirmationTemplateInput, pickGuestLocale, renderBookingTemplate, DEFAULT_CONFIRMATION_SUBJECT, DEFAULT_CONFIRMATION_BODY } = await import(pathToFileURL(join(dir, "c.mjs")).href);

const startsAt = new Date("2026-11-17T13:00:00Z");
const endsAt = new Date("2026-11-17T13:30:00Z");
const content = { eventName: "Intro call", hostName: "Paul", guestName: "Ana", location: "", notes: "", startsAt, endsAt, timeZone: "Europe/Berlin" };

test("formats the slot in the event's time zone, worded for the guest's locale", () => {
	assert.match(formatBookingWhen(startsAt, endsAt, "Europe/Berlin"), /^Tuesday,? 17 November 2026, 14:00–14:30 \(Europe\/Berlin\)$/);
	assert.match(formatBookingWhen(startsAt, endsAt, "Europe/Berlin", "de"), /^Dienstag, 17\. November 2026, 14:00–14:30 \(Europe\/Berlin\)$/);
});

test("falls back to UTC for an unknown time zone", () => {
	assert.match(formatBookingWhen(startsAt, endsAt, "Not/AZone"), /13:00–13:30 \(UTC\)$/);
});

test("picks the booking page language, then the browser's, then English", () => {
	assert.equal(pickGuestLocale("de", "en-US,en;q=0.9"), "de");
	assert.equal(pickGuestLocale(null, "fr-FR,de;q=0.8"), "fr-FR");
	assert.equal(pickGuestLocale("not a tag!", "*"), "en-GB");
	assert.equal(pickGuestLocale(undefined, undefined), "en-GB");
});

test("without a template the default English text is sent, dropping an empty location", () => {
	const mail = buildBookingConfirmation(content);
	assert.equal(mail.subject, "Confirmed: Intro call with Paul");
	assert.match(mail.text, /^Hi Ana,\n\nyour booking is confirmed: Intro call with Paul\.\n\nWhen: Tuesday,? 17 November 2026, 14:00–14:30 \(Europe\/Berlin\)\n\nThe attached calendar file/);
	assert.doesNotMatch(mail.text, /Where:|Notes:|\{/);
	const full = buildBookingConfirmation({ ...content, location: "https://meet.example/abc", notes: "About pricing" });
	assert.match(full.text, /\nWhere: https:\/\/meet\.example\/abc\n/);
	assert.doesNotMatch(full.text, /About pricing|Notes:/);
});

test("the default template only uses placeholders the editor offers", () => {
	const names = [...`${DEFAULT_CONFIRMATION_SUBJECT}\n${DEFAULT_CONFIRMATION_BODY}`.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
	assert.deepEqual([...new Set(names)].sort(), ["eventName", "guestName", "hostName", "location", "when"]);
});

test("a template fills known placeholders, leaves others as written and drops lines left empty", () => {
	const values = { guestName: "Ana", eventName: "Beratung", hostName: "Paul", when: "morgen", location: "", notes: "" };
	assert.equal(renderBookingTemplate("Hallo {guestName}, {eventName} {when} {unknown}.\nOrt: {location}\nNotiz: {notes} / {location}\nBis bald", values), "Hallo Ana, Beratung morgen {unknown}.\nBis bald");
});

test("the event's subject and body replace the default, each on its own", () => {
	const guest = { ...content, eventName: "Beratung", guestName: "Ana\nBcc: x@evil.test", location: "Telefon", notes: "Preise" };
	const custom = buildBookingConfirmation(guest, "de", { subject: "Termin am {when} für {guestName}", body: "Hallo {guestName},\nwir sehen uns {when} ({location}).\n{notes}" });
	assert.equal(custom.subject, "Termin am Dienstag, 17. November 2026, 14:00–14:30 (Europe/Berlin) für Ana Bcc: x@evil.test");
	assert.equal(custom.text, "Hallo Ana Bcc: x@evil.test,\nwir sehen uns Dienstag, 17. November 2026, 14:00–14:30 (Europe/Berlin) (Telefon).\nPreise");
	const subjectOnly = buildBookingConfirmation(guest, "de", { subject: "Ihr Termin", body: "" });
	assert.equal(subjectOnly.subject, "Ihr Termin");
	assert.match(subjectOnly.text, /^Hi Ana/);
	const bodyOnly = buildBookingConfirmation(guest, "de", { subject: "", body: "Danke!" });
	assert.equal(bodyOnly.subject, "Confirmed: Beratung with Paul");
	assert.equal(bodyOnly.text, "Danke!");
	assert.equal(buildBookingConfirmation(guest, "de", { subject: "{notes}", body: "" }).subject, "Preise");
	assert.equal(buildBookingConfirmation({ ...guest, notes: "" }, "de", { subject: "{notes}", body: "" }).subject, "Confirmed: Beratung with Paul");
});

test("confirmation fields in a booking event request are optional, trimmed and bounded", () => {
	assert.equal(parseConfirmationTemplateInput({ name: "x" }), undefined);
	assert.equal(parseConfirmationTemplateInput(null), undefined);
	assert.deepEqual(parseConfirmationTemplateInput({ confirmationSubject: " Hi\r\nthere ", confirmationBody: " a\r\nb " }), { subject: "Hi there", body: "a\nb" });
	assert.deepEqual(parseConfirmationTemplateInput({ confirmationBody: "only body" }), { subject: "", body: "only body" });
	assert.equal(parseConfirmationTemplateInput({ confirmationSubject: 5 }), null);
	assert.equal(parseConfirmationTemplateInput({ confirmationSubject: "x".repeat(201) }), null);
	assert.equal(parseConfirmationTemplateInput({ confirmationBody: "x".repeat(5001) }), null);
});

test("the calendar file is a plain event to add, not a meeting request", () => {
	const ics = new TextDecoder().decode(buildBookingCalendarFile({ title: "Beratung (Paul)", description: "Hallo", location: "Telefon", startsAt, endsAt, uid: "bkg_1" }));
	assert.match(ics, /\r\nMETHOD:PUBLISH\r\n/);
	assert.match(ics, /\r\nDTSTART:20261117T130000Z\r\nDTEND:20261117T133000Z\r\n/);
	assert.doesNotMatch(ics, /ORGANIZER|ATTENDEE|RSVP/);
});

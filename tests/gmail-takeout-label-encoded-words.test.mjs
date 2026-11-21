import assert from "node:assert/strict";
import test from "node:test";
import { parseGmailLabels } from "../src/lib/import/gmail-takeout-utils.ts";

const raw = (header) => new TextEncoder().encode(`${header}\r\nSubject: x\r\n\r\nbody\r\n`);

test("a label folded into several encoded words joins without the folding space (RFC 2047 6.2)", () => {
	const header = "X-Gmail-Labels: =?UTF-8?Q?Gesch=C3=A4ftliche_Rechnungen_und_Belege_aus_dem_Jahr_2026_?=\r\n =?UTF-8?Q?f=C3=BCr_die_Steuer?=";
	assert.deepEqual(parseGmailLabels(raw(header)), ["Geschäftliche Rechnungen und Belege aus dem Jahr 2026 für die Steuer"]);
	assert.deepEqual(parseGmailLabels(raw("X-Gmail-Labels: =?UTF-8?B?w4Q=?= =?UTF-8?B?w5Y=?=\t=?UTF-8?Q?=C3=9C?=")), ["ÄÖÜ"]);
});

test("space next to plain text is kept", () => {
	assert.deepEqual(parseGmailLabels(raw("X-Gmail-Labels: Inbox,=?UTF-8?Q?K=C3=BCche?= alt,neu =?UTF-8?Q?K=C3=BCche?=")), ["Inbox", "Küche alt", "neu Küche"]);
});

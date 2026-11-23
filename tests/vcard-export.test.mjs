import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The export route bundles with the real SQLite driver and migrations; auth and env are mocked.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.vcfEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.vcfUser}",
};
const { app, newDatabase } = await loadApp("vcf-export", `
	export { GET } from "./src/app/api/export/contacts/route.ts";
	export { contactsToVcf } from "./src/lib/export/vcard.ts";
`, { mocks });
const { GET, contactsToVcf } = app;

const seed = `${sharedMailboxSeed("read_only")}
	INSERT INTO contacts (id, user_id, email, display_name, source, blocked, created_at) VALUES
		('c-1', 'admin', 'maya@example.com', 'Maya, Smith', 'manual', 0, 1),
		('c-2', 'admin', 'blocked@example.com', 'Spammy Sender', 'inbound', 1, 1),
		('c-3', 'admin', 'noname@example.com', NULL, 'inbound', 0, 1),
		('c-4', 'admin', 'unicode@example.com', 'José García 日本語', 'manual', 0, 1),
		('c-5', 'admin', 'unseen@example.com', 'Hidden', 'manual', 0, 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'maya@example.com', 'team@example.com', 'Hi', 'received', 1),
		('m-2', 'admin', 'mb-team', 'outbound', 'team@example.com', 'blocked@example.com, noname@example.com', 'Out', 'sent', 2),
		('m-3', 'admin', 'mb-team', 'inbound', 'unicode@example.com', 'team@example.com', 'Uni', 'received', 3);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
const get = (path) => new Request(`http://localhost${path}`);
async function setup(t, who) {
	const { env } = await newDatabase(t, seed);
	globalThis.vcfEnv = env;
	globalThis.vcfUser = user(who);
}
const cards = (vcf) => vcf.split("END:VCARD").length - 1;

test("escaping: commas, semicolons and line breaks in names are escaped per RFC 2426", () => {
	const vcf = contactsToVcf([{ email: "a@example.com", displayName: 'Doe, John; "JD"\nLine 2', blocked: false }]);
	assert.match(vcf, /N:Doe\\, John\\; "JD"\\nLine 2;;;;\r\n/);
	assert.match(vcf, /FN:Doe\\, John\\; "JD"\\nLine 2\r\n/);
	assert.doesNotMatch(vcf, /JD"\nLine/);
});

test("a contact without a name falls back to the email address for N and FN", () => {
	const vcf = contactsToVcf([{ email: "noname@example.com", displayName: null, blocked: false }]);
	assert.match(vcf, /N:noname@example\.com;;;;/);
	assert.match(vcf, /FN:noname@example\.com/);
});

test("missing or blank names never produce an empty N or FN", () => {
	for (const displayName of [null, "", "   "]) {
		const vcf = contactsToVcf([{ email: "x@example.com", displayName, blocked: false }]);
		assert.match(vcf, /N:x@example\.com;;;;\r\nFN:x@example\.com\r\n/);
	}
});

test("unicode names are written as UTF-8 and lines fold at 75 octets without splitting a character", () => {
	const longName = "José " + " García-Łóźń".repeat(12) + " 日本語の名前";
	const vcf = contactsToVcf([{ email: "u@example.com", displayName: longName, blocked: false }]);
	assert.match(vcf, /日本語/);
	for (const line of vcf.split("\r\n")) {
		assert.ok(new TextEncoder().encode(line).length <= 75, `line over 75 octets: ${line}`);
	}
	// A folded line continues with a single leading space.
	assert.match(vcf, /\r\n /);
	// No bare line feeds: every newline is CRLF.
	assert.equal(vcf.split("\n").length - 1, vcf.split("\r\n").length - 1);
});

test("a blocked contact keeps its flag as a standard CATEGORIES entry", () => {
	const vcf = contactsToVcf([
		{ email: "blocked@example.com", displayName: "Spammer", blocked: true },
		{ email: "ok@example.com", displayName: "Friend", blocked: false },
	]);
	assert.match(vcf, /BEGIN:VCARD[\s\S]*CATEGORIES:Blocked[\s\S]*END:VCARD/);
	const friendCard = vcf.split("BEGIN:VCARD")[2];
	assert.doesNotMatch(friendCard, /CATEGORIES/);
	assert.equal(cards(vcf), 2);
});

test("cards carry the vCard 3.0 envelope", () => {
	const vcf = contactsToVcf([{ email: "a@example.com", displayName: "A", blocked: false }]);
	assert.match(vcf, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
	assert.match(vcf, /END:VCARD\r\n$/);
	assert.match(vcf, /EMAIL:a@example\.com\r\n/);
});

test("the owner exports the whole address book, blocked contacts included", async (t) => {
	await setup(t, "admin");
	const response = await GET(get("/api/export/contacts?mailboxId=mb-team"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Content-Type"), "text/vcard; charset=utf-8");
	assert.match(response.headers.get("Content-Disposition") ?? "", /filename="contacts\.vcf"/);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const vcf = await response.text();
	assert.equal(cards(vcf), 5);
	for (const email of ["maya@example.com", "blocked@example.com", "noname@example.com", "unicode@example.com", "unseen@example.com"]) {
		assert.match(vcf, new RegExp(`EMAIL:${email.replaceAll(".", "\\.")}`));
	}
	assert.match(vcf, /N:Maya\\, Smith;;;;/);
	assert.match(vcf, /CATEGORIES:Blocked/);
});

test("a shared-mailbox delegate exports only the contacts visible on its mail", async (t) => {
	await setup(t, "delegate");
	const response = await GET(get("/api/export/contacts?mailboxId=mb-team"));
	assert.equal(response.status, 200);
	const vcf = await response.text();
	assert.equal(cards(vcf), 4);
	assert.doesNotMatch(vcf, /unseen@example\.com/);
	assert.match(vcf, /EMAIL:maya@example\.com/);
	assert.match(vcf, /EMAIL:blocked@example\.com/);
});

test("a mailbox the user cannot read returns 404, and a missing mailbox id returns 400", async (t) => {
	await setup(t, "delegate");
	assert.equal((await GET(get("/api/export/contacts"))).status, 400);
	assert.equal((await GET(get("/api/export/contacts?mailboxId=mb-admin"))).status, 404);
	assert.equal((await GET(get("/api/export/contacts?mailboxId=mb-nope"))).status, 404);
});

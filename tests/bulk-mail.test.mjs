import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-bulk-detect-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/bulk-mail.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { detectBulkMail, isBulkMail } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("detectBulkMail.bulk always equals isBulkMail().bulk", () => {
	const fixtures = [
		undefined,
		{},
		{ "List-Unsubscribe": "<mailto:u@x.test>" },
		{ "list-id": "<a.x.test>" },
		{ precedence: "bulk" },
		{ "x-campaign": "spring" },
		{ "feedback-id": "a:b:c:ses" },
		{ "auto-submitted": "auto-generated" },
		{ "x-mailer": "Mailchimp Mailer" },
	];
	for (const headers of fixtures) assert.equal(detectBulkMail(headers).bulk, isBulkMail(headers).bulk);
});

test("bulk senders are marketing, discussion lists are list", () => {
	assert.equal(detectBulkMail({ "List-Unsubscribe": "<https://x.test/u>" }).kind, "marketing");
	assert.equal(detectBulkMail({ "list-id": "<a.x.test>", "list-post": "<mailto:a@x.test>" }).kind, "list");
	assert.equal(detectBulkMail({ "list-id": "<a.x.test>", precedence: "list" }).kind, "list");
	assert.equal(detectBulkMail({ precedence: "bulk" }).kind, "marketing");
	assert.equal(detectBulkMail({}).kind, null);
	assert.equal(detectBulkMail(undefined).kind, null);
});

test("signals mirror isBulkMail reasons and list-post makes a list even with List-Unsubscribe", () => {
	const verdict = detectBulkMail({ "List-Unsubscribe": "<mailto:u@x.test>", "list-post": "<mailto:a@x.test>" });
	assert.deepEqual(verdict.signals, ["list-unsubscribe"]);
	assert.equal(verdict.kind, "list");
});

test("ESP trace headers never make mail bulk or marketing", () => {
	for (const headers of [{ "X-Mailer": "Mailchimp Mailer - **CID1**" }, { "x-sg-eid": "abc" }, { "x-ses-outgoing": "2026.1.1-1.2.3.4" }, { "x-mailgun-tag": "receipt" }, { "x-mc-user": "u" }]) {
		assert.deepEqual(detectBulkMail(headers), { bulk: false, kind: null, signals: [] });
	}
});

test("an auto-submitted marker is never bulk or marketing", () => {
	assert.equal(detectBulkMail({ "auto-submitted": "auto-generated", "x-mailer": "Brevo" }).kind, null);
});

test("headers are matched case-insensitively", () => {
	for (const key of ["List-Id", "LIST-ID", "list-id"]) assert.equal(detectBulkMail({ [key]: "<a.x.test>" }).bulk, true);
});

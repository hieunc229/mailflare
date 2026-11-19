import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-attachment-limits-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB, outboundAttachmentCeilingMb, clampOutboundAttachmentMb, outgoingSizeError, requestBodyLimit, planAttachmentDelivery } = await bundle("src/lib/email/attachment-limits.ts", "limits.mjs");
const { sharedFileNotice, MAX_SHARED_FILES_NOTICE_LENGTH } = await bundle("src/lib/email/shared-file-notice.ts", "notice.mjs");

const MB = 1_000_000;

test("the default limit stays at 25 MB and the ceiling allows an administrator to raise it", () => {
	assert.equal(DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB, 25);
	assert.equal(outboundAttachmentCeilingMb(false), 25);
	assert.equal(outboundAttachmentCeilingMb(true), 50);
});

test("outgoing size limit: each file and the total stay within the administrator's setting", () => {
	assert.equal(outgoingSizeError([25 * MB], 25), null);
	assert.match(outgoingSizeError([25 * MB + 1], 25), /25 MB/);
	assert.match(outgoingSizeError([15 * MB, 15 * MB], 25), /25 MB/);
	assert.equal(outgoingSizeError([40 * MB], 50), null);
	assert.match(outgoingSizeError([51 * MB], 50), /50 MB/);
	assert.equal(outgoingSizeError([], 25), null);
});

test("request bodies keep the 30 MiB cap at the default and grow with a raised limit", () => {
	assert.equal(requestBodyLimit(25), 30 * 1024 * 1024);
	assert.ok(requestBodyLimit(50) >= (50 * MB * 4) / 3, "room for a base64 JSON body of the largest allowed file");
});

test("Cloudflare sends files over 3 MB, or past the 5 MiB message cap, as links", () => {
	assert.deepEqual(planAttachmentDelivery("cloudflare", [2 * MB, 4 * MB], 10_000), [false, true]);
	assert.deepEqual(planAttachmentDelivery("cloudflare", [2_900_000, 2_900_000], 10_000), [false, true], "the second file would push the message past 5 MiB");
});

test("Resend and SES keep files up to 25 MB attached and link anything past it", () => {
	for (const provider of ["resend", "ses"]) {
		assert.deepEqual(planAttachmentDelivery(provider, [24 * MB], 10_000), [false]);
		assert.deepEqual(planAttachmentDelivery(provider, [25 * MB, 25 * MB], 10_000), [false, true]);
		assert.deepEqual(planAttachmentDelivery(provider, [30 * MB, 5 * MB], 10_000), [true, false]);
	}
});

test("nothing is linked on Resend or SES while the administrator's limit is the default", () => {
	assert.deepEqual(planAttachmentDelivery("resend", [10 * MB, 15 * MB], 10_000), [false, false]);
});

const files = [{ filename: "Q3 <report>.pdf", size: 31_400_000, url: "https://mail.example.com/api/shared-files/share_1?a=1&b=2" }];

test("a custom notice replaces the default text and fills {days}", () => {
	const notice = sharedFileNotice(files, 30, undefined, "Archivos compartidos (caducan en {days} días):");
	assert.equal(notice.intro, "Archivos compartidos (caducan en 30 días):");
	assert.match(notice.htmlBlock, /^<div><p>Archivos compartidos \(caducan en 30 días\):<\/p><ul>/);
	assert.ok(notice.textBlock("Hola").startsWith("Hola\n\nArchivos compartidos"));
	assert.match(notice.textBlock("Hola"), /Q3 <report>\.pdf \(31\.4 MB\): https:\/\/mail\.example\.com/);
});

test("no custom notice (null) uses the default; an empty one removes the message but keeps the links", () => {
	assert.match(sharedFileNotice(files, 30, undefined, null).intro, /^Files shared through Mailflare/);
	const none = sharedFileNotice(files, 30, undefined, "  ");
	assert.equal(none.intro, "");
	assert.doesNotMatch(none.htmlBlock, /<p>/);
	assert.match(none.htmlBlock, /<ul><li>Q3 &lt;report&gt;\.pdf \(31\.4 MB\): <a href="[^"]+">Download file<\/a><\/li><\/ul>/);
	assert.equal(none.textBlock(undefined), "Q3 <report>.pdf (31.4 MB): https://mail.example.com/api/shared-files/share_1?a=1&b=2");
});

test("HTML in a custom notice is escaped in the HTML body and never becomes markup", () => {
	const notice = sharedFileNotice(files, 30, undefined, '<script>alert(1)</script><img src=x onerror=1> "{days}"\nline two');
	assert.doesNotMatch(notice.htmlBlock, /<script|<img/);
	assert.match(notice.htmlBlock, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(notice.htmlBlock, /&quot;30&quot;<br>line two/);
	assert.match(notice.textBlock(""), /^<script>alert\(1\)<\/script>/, "the plain-text part stays literal text");
});

test("unknown placeholders stay as written and the length cap is exported", () => {
	assert.equal(sharedFileNotice(files, 7, undefined, "{days} {nope}").intro, "7 {nope}");
	assert.ok(MAX_SHARED_FILES_NOTICE_LENGTH > 100 && MAX_SHARED_FILES_NOTICE_LENGTH <= 1000);
});

test("the ceiling is 25 MB on Workers and 50 MB on Node/Docker; stored values are clamped per runtime", () => {
	assert.equal(clampOutboundAttachmentMb(50, false), 25);
	assert.equal(clampOutboundAttachmentMb(40, false), 25);
	assert.equal(clampOutboundAttachmentMb(40, true), 40);
	assert.equal(clampOutboundAttachmentMb(500, true), 50);
	assert.equal(clampOutboundAttachmentMb(10, false), 10);
	assert.equal(clampOutboundAttachmentMb(0, true), 1);
	assert.equal(clampOutboundAttachmentMb(Number.NaN, true), 25);
	assert.equal(clampOutboundAttachmentMb(undefined, false), 25);
});

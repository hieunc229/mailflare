import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-inbound-hardening-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: [
			`export { analyzeAuthentication } from "./src/lib/spam/analyzers/authentication";`,
			`export { boundParsedEmail, capChars, truncateUtf8 } from "./src/lib/email/inbound-limits";`,
			`export { sanitizeFilename } from "./src/lib/email/attachments";`,
			`export { getAttachmentContentDisposition } from "./src/app/api/messages/[messageId]/attachments/[attachmentId]/utils";`,
			`export { isPublicHttpsUrl } from "./src/lib/security/public-url";`,
			`export { parseRemoteImageUrl } from "./src/lib/remote-images/fetch";`,
		].join("\n"),
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});

const lib = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const ids = (signals) => signals.map((signal) => signal.id).sort();

test("a forged Authentication-Results pass cannot hide a real failure", () => {
	const real = "mx.cloudflare.net; spf=fail dkim=fail dmarc=fail";
	const forged = "mx.cloudflare.net; spf=pass dkim=pass dmarc=pass";
	assert.deepEqual(ids(lib.analyzeAuthentication({ "authentication-results": `${real}, ${forged}` })), ["dkim_failed", "dmarc_failed", "spf_failed"]);
	assert.deepEqual(ids(lib.analyzeAuthentication({ "authentication-results": `${forged}, ${real}` })), ["dkim_failed", "dmarc_failed", "spf_failed"]);
	assert.deepEqual(ids(lib.analyzeAuthentication({ "authentication-results": "mx.cloudflare.net.evil.example; dmarc=pass" })), []);
	assert.deepEqual(ids(lib.analyzeAuthentication({ "authentication-results": forged })), ["dkim_passed", "dmarc_passed", "spf_passed"]);
});

test("capChars and truncateUtf8 never leave half a character", () => {
	const subject = `${"a".repeat(997)}😀`;
	assert.equal(subject.length, 999);
	const capped = lib.capChars(subject, 998);
	assert.equal(capped.length, 997);
	assert.doesNotMatch(capped, /[\ud800-\udbff]$/);
	const bytes = new TextEncoder().encode(lib.truncateUtf8("日本語".repeat(10), 10));
	assert.ok(bytes.byteLength <= 10);
	assert.doesNotMatch(new TextDecoder().decode(bytes), /�/);
});

test("boundParsedEmail keeps oversized fields insertable", () => {
	const parsed = lib.boundParsedEmail({
		subject: "s".repeat(5000), text: "t".repeat(2_000_000), html: "h".repeat(3_000_000),
		messageId: `<${"m".repeat(5000)}@x>`, fromAddr: `${"f".repeat(400)}@example.com`, toAddr: null, ccAddr: null, bccAddr: null,
		replyTo: null, inReplyTo: `<${"r".repeat(600)}@x>`, references: ["<ok@x>", `<${"r".repeat(600)}@x>`], date: null, attachments: [],
	});
	assert.equal(parsed.subject.length, 998);
	assert.ok(new TextEncoder().encode(parsed.text).byteLength <= 450_000);
	assert.ok(new TextEncoder().encode(parsed.html).byteLength <= 900_000);
	assert.equal(parsed.messageId, null);
	assert.equal(parsed.inReplyTo, null);
	assert.deepEqual(parsed.references, ["<ok@x>"]);
});

test("filenames and Content-Disposition survive CJK, control characters and length", () => {
	assert.equal(lib.sanitizeFilename(".."), "attachment");
	assert.equal(lib.sanitizeFilename("."), "attachment");
	assert.equal(lib.sanitizeFilename("a/b\\c\u0000‮.pdf"), "a_b_c.pdf");
	const long = lib.sanitizeFilename(`${"長".repeat(400)}.pdf`);
	assert.ok(new TextEncoder().encode(long).byteLength <= 180);
	assert.ok(long.endsWith(".pdf"));
	const header = lib.getAttachmentContentDisposition("日本語\r\n\".pdf", false);
	assert.match(header, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
	assert.doesNotMatch(header, /[\r\n]/);
	assert.ok(lib.getAttachmentContentDisposition("x".repeat(5000), true).length < 700);
});

test("webhook and image URLs reject private, wildcard-DNS and credentialed hosts", () => {
	assert.equal(lib.isPublicHttpsUrl("https://hooks.example.com/in"), true);
	for (const url of [
		"http://hooks.example.com/in", "https://127.0.0.1/in", "https://localhost/in", "https://[::1]/in",
		"https://user:pw@hooks.example.com/in", "https://127.0.0.1.nip.io/in", "https://169-254-169-254.sslip.io/in", "https://db.internal/in", "not a url",
	]) assert.equal(lib.isPublicHttpsUrl(url), false, url);
	assert.throws(() => lib.parseRemoteImageUrl("https://127.0.0.1.nip.io/a.png"));
	assert.throws(() => lib.parseRemoteImageUrl("https://169.254.169.254.sslip.io/a.png"));
	assert.ok(lib.parseRemoteImageUrl("https://images.example.com/a.png"));
});

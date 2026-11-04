import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mime-bounds-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const root = process.cwd();
const entry = join(dir, "entry.ts");
writeFileSync(entry, `
import { MimeLimitError, parseRawMime } from "${root}/src/lib/email/parse";
import { htmlToReadableText } from "${root}/src/lib/email/reply-content-utils";
const enc = new TextEncoder();
const hdr = "From: a@b.example\\r\\nTo: c@d.example\\r\\nSubject: x\\r\\n";
const b64Part = 'Content-Type: multipart/mixed; boundary="b"\\r\\n\\r\\n--b\\r\\nContent-Type: application/pdf\\r\\nContent-Transfer-Encoding: base64\\r\\nContent-Disposition: attachment; filename=a.pdf\\r\\n\\r\\n';
const hostile = {
	blank: hdr + "\\r\\n" + "\\r\\n".repeat(512 * 1024),
	shortLines: hdr + "\\r\\n" + "a\\r\\n".repeat(262144),
	spaceLines: hdr + "\\r\\n" + " \\r\\n".repeat(262144),
	textLines: hdr + "\\r\\n" + ("a".repeat(78) + "\\r\\n").repeat(262144),
	lfLines: hdr + "\\n" + "a\\n".repeat(262144),
	nested: hdr + "Content-Type: message/rfc822\\r\\n\\r\\n".repeat(5000),
	parts: hdr + 'Content-Type: multipart/mixed; boundary="b"\\r\\n\\r\\n' + "--b\\r\\nContent-Type: text/plain\\r\\n\\r\\nx\\r\\n".repeat(20000),
	headers: "X-Pad: " + "a".repeat(200 * 1024) + "\\r\\n\\r\\nbody",
};
const out = { rejected: {}, ok: {} };
for (const [name, text] of Object.entries(hostile)) {
	try {
		await parseRawMime(enc.encode(text).buffer);
		out.rejected[name] = null;
	} catch (error) {
		out.rejected[name] = error instanceof MimeLimitError ? error.message : "other: " + error;
	}
}
// A 25 MB-class base64 attachment is ~340k short lines and must still parse.
const legit = hdr + b64Part + ("QUFB".repeat(19) + "\\r\\n").repeat(340000) + "--b--\\r\\n";
const parsed = await parseRawMime(enc.encode(legit).buffer);
out.ok.attachments = parsed.attachments.length;
out.ok.plain = (await parseRawMime(enc.encode(hdr + "\\r\\nhello\\r\\n").buffer)).text?.trim();
out.htmlText = htmlToReadableText("<style>a{}</style><p>Hi &amp; bye</p>").trim();
out.htmlBomb = htmlToReadableText("<style>".repeat(20000) + "<p>hi</p>").includes("hi");
console.log(JSON.stringify(out));
`);
const bundle = join(dir, "entry.mjs");
await build({ entryPoints: [entry], bundle: true, outfile: bundle, platform: "node", format: "esm", alias: { "@": join(root, "src") }, logLevel: "silent", banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });

test("hostile MIME is rejected, legit mail parses, all inside a 128 MB heap", () => {
	const out = JSON.parse(execFileSync(process.execPath, ["--max-old-space-size=128", bundle], { encoding: "utf8" }));
	for (const [name, reason] of Object.entries(out.rejected)) {
		assert.match(String(reason), /^Message rejected:/, `${name} was not rejected: ${reason}`);
	}
	assert.equal(out.ok.attachments, 1);
	assert.equal(out.ok.plain, "hello");
	assert.equal(out.htmlText, "Hi & bye");
	assert.equal(out.htmlBomb, true);
});

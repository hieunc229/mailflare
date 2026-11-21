import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-shared-notice-"));
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

const { sharedFileNotice } = await bundle("src/lib/email/shared-file-notice.ts", "notice.mjs");
const { createTranslator } = await bundle("src/lib/i18n/utils.ts", "i18n.mjs");
const files = [{ filename: "Q3 <report>.pdf", size: 31_400_000, url: "https://mail.example.com/api/shared-files/share_1?a=1&b=2" }];

test("the shared-files notice defaults to English and states the real link lifetime", () => {
	const notice = sharedFileNotice(files, 30);
	assert.equal(notice.intro, "Files shared through Mailflare (download links expire after 30 days):");
	assert.equal(notice.text, "Q3 <report>.pdf (31.4 MB): https://mail.example.com/api/shared-files/share_1?a=1&b=2");
	assert.match(notice.html, /<li>Q3 &lt;report&gt;\.pdf \(31\.4 MB\): <a href="https:\/\/mail\.example\.com\/api\/shared-files\/share_1\?a=1&amp;b=2">Download file<\/a><\/li>/);
	assert.match(sharedFileNotice(files, 7).intro, /expire after 7 days/);
});

test("the shared-files notice follows the sender's language", () => {
	const de = JSON.parse(readFileSync(join(root, "public/locales/de.json"), "utf8"));
	const notice = sharedFileNotice(files, 30, createTranslator("de", de));
	assert.equal(notice.intro, de["attachment.sharedIntro"].replace("{days}", "30"));
	assert.ok(notice.html.includes(`>${de["attachment.sharedDownload"]}</a>`));
	assert.doesNotMatch(notice.intro, /Files shared through/);
});

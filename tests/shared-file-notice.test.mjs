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

const { sharedFileNotice, clampSharedLinkDays, formatFileSize, fileExtension, SHARED_NOTICE_MAX_LENGTH } = await bundle("src/lib/email/shared-file-notice.ts", "notice.mjs");
const { createTranslator } = await bundle("src/lib/i18n/utils.ts", "i18n.mjs");
const files = [{ filename: "Q3 <report>.pdf", size: 31_400_000, type: "application/pdf", url: "https://mail.example.com/api/shared-files/share_1?a=1&b=2" }];
const two = [
	...files,
	{ filename: "hoja.xlsx", size: 1_200_000, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url: "https://mail.example.com/api/shared-files/share_2" },
];

test("the shared-files notice defaults to English and states the real link lifetime", () => {
	const notice = sharedFileNotice(files, { days: 30 });
	assert.equal(notice.intro, "Files shared through Mailflare (download links expire after 30 days):");
	assert.equal(notice.text, "Q3 &lt;report&gt;.pdf (PDF · 31.4 MB): https://mail.example.com/api/shared-files/share_1?a=1&amp;b=2");
	assert.match(sharedFileNotice(files, { days: 7 }).intro, /expire after 7 days/);
});

test("the shared-files notice follows the sender's language", () => {
	const de = JSON.parse(readFileSync(join(root, "public/locales/de.json"), "utf8"));
	const notice = sharedFileNotice(files, { days: 30, t: createTranslator("de", de) });
	assert.equal(notice.intro, de["attachment.sharedIntro"].replace("{days}", "30"));
	assert.ok(notice.html.includes(de["attachment.sharedDownload"]));
	assert.doesNotMatch(notice.intro, /Files shared through/);
});

test("the Spanish catalog states the Spanish sentence the issue asks for", () => {
	const es = JSON.parse(readFileSync(join(root, "public/locales/es.json"), "utf8"));
	const notice = sharedFileNotice(files, { days: 30, t: createTranslator("es", es) });
	assert.equal(notice.intro, "Archivos compartidos a través de Mailflare (los enlaces de descarga caducan después de 30 días):");
	assert.match(notice.htmlBlock, /Archivos compartidos a través de Mailflare/);
});

test("disabling the notice removes the sentence but keeps the download cards", () => {
	const notice = sharedFileNotice(files, { enabled: false, days: 30 });
	assert.equal(notice.intro, "");
	assert.doesNotMatch(notice.htmlBlock, /Files shared through/);
	assert.match(notice.htmlBlock, /href="https:\/\/mail\.example\.com\/api\/shared-files\/share_1\?a=1&amp;b=2"/);
	assert.match(notice.textBlock("Body"), /^Body\n\nQ3 &lt;report&gt;\.pdf/);
	assert.doesNotMatch(notice.textBlock("Body"), /Files shared through/);
});

test("a custom sentence wins, fills {days} and is escaped instead of becoming markup", () => {
	const notice = sharedFileNotice(files, { text: "<script>alert(1)</script> caducan en {days} días", days: 14 });
	assert.ok(notice.intro.startsWith("<script>alert(1)</script> caducan en 14 días"));
	assert.doesNotMatch(notice.htmlBlock, /<script>/);
	assert.ok(notice.htmlBlock.includes("&lt;script&gt;alert(1)&lt;/script&gt; caducan en 14 días"));
});

test("an empty custom sentence uses the translated default", () => {
	const notice = sharedFileNotice(files, { text: "   ", days: 30 });
	assert.equal(notice.intro, "Files shared through Mailflare (download links expire after 30 days):");
});

test("the custom sentence is capped", () => {
	const notice = sharedFileNotice(files, { text: "x".repeat(SHARED_NOTICE_MAX_LENGTH + 40), days: 30 });
	assert.equal(notice.intro.length, SHARED_NOTICE_MAX_LENGTH);
});

test("cards are tables with inline styles, one clickable box per file and no script", () => {
	const notice = sharedFileNotice(two, { days: 30 });
	assert.match(notice.htmlBlock, /<table role="presentation" cellpadding="0" cellspacing="0" border="0"/);
	assert.doesNotMatch(notice.htmlBlock, /<script|onclick|<style|display:flex/);
	// One anchor per file, each wrapping the whole card.
	const anchors = notice.htmlBlock.match(/<a href="[^"]+"/g) ?? [];
	assert.equal(anchors.length, 2);
	// Each file keeps its own name, badge, extension and size.
	assert.ok(notice.htmlBlock.includes("Q3 &lt;report&gt;.pdf"));
	assert.ok(notice.htmlBlock.includes("PDF · 31.4 MB"));
	assert.ok(notice.htmlBlock.includes("XLSX · 1.2 MB"));
	assert.ok(notice.htmlBlock.includes(">PDF</td>"));
	assert.ok(notice.htmlBlock.includes(">XLSX</td>"));
	// The badge is a solid-colour cell Outlook keeps.
	assert.match(notice.htmlBlock, /bgcolor="#dc2626"/);
	assert.match(notice.htmlBlock, /bgcolor="#15803d"/);
});

test("the expiry is stated once: in the intro, or inside the cards when there is no intro", () => {
	// Each card states its own lifetime, once per file, so a reader who skips the sentence still sees it.
	assert.equal((sharedFileNotice(two, { days: 30 }).htmlBlock.match(/Expires in 30 days/g) ?? []).length, 2);
	// With the notice switched off the cards stay and the expiry goes away with it.
	assert.equal((sharedFileNotice(two, { days: 30, enabled: false }).htmlBlock.match(/Expires in/g) ?? []).length, 0);
});

test("the links style keeps the plain list from before", () => {
	const notice = sharedFileNotice(files, { style: "links", days: 30 });
	assert.doesNotMatch(notice.htmlBlock, /<table/);
	assert.match(notice.htmlBlock, /<ul><li>Q3 &lt;report&gt;\.pdf \(PDF · 31\.4 MB\): <a href="https:\/\/mail\.example\.com\/api\/shared-files\/share_1\?a=1&amp;b=2">Download file<\/a><\/li><\/ul>/);
});

test("the link lifetime is clamped to 1..365 days", () => {
	assert.equal(clampSharedLinkDays(0), 1);
	assert.equal(clampSharedLinkDays(999), 365);
	assert.equal(clampSharedLinkDays(7.9), 7);
	assert.equal(clampSharedLinkDays(null), 30);
	assert.equal(clampSharedLinkDays(Number.NaN), 30);
});

test("file details come from the filename and the MIME type", () => {
	assert.equal(fileExtension("informe.PDF"), "PDF");
	assert.equal(fileExtension("sin-extension", "image/png"), "PNG");
	assert.equal(formatFileSize(940), "940 B");
	assert.equal(formatFileSize(31_400_000), "31.4 MB");
});

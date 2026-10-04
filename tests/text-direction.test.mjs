import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-text-direction-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/compose/rich-text-utils.ts")],
	outfile: join(outDir, "rich-text-utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const utils = await import(pathToFileURL(join(outDir, "rich-text-utils.mjs")).href);

const RTL_ATTRIBUTES = 'dir="rtl" style="direction: rtl; text-align: right"';

test("direction follows the first strong character, like dir=auto", () => {
	assert.equal(utils.detectTextDirection("שלום עולם"), "rtl");
	assert.equal(utils.detectTextDirection("مرحبا بالعالم"), "rtl");
	assert.equal(utils.detectTextDirection("Hello שלום"), "ltr");
	assert.equal(utils.detectTextDirection("שלום Hello"), "rtl");
	assert.equal(utils.detectTextDirection("123, - (שלום)"), "rtl");
	assert.equal(utils.detectTextDirection("2026 report"), "ltr");
	assert.equal(utils.detectTextDirection("   "), null);
	assert.equal(utils.detectTextDirection("12:30 - 13:00"), null);
	assert.equal(utils.detectTextDirection(null), null);
});

test("containsRtlText finds right-to-left characters anywhere", () => {
	assert.equal(utils.containsRtlText("Meeting at 10, ביום שני"), true);
	assert.equal(utils.containsRtlText("Plain English only"), false);
	assert.equal(utils.containsRtlText(""), false);
});

test("textToHtml marks right-to-left text and leaves left-to-right text unchanged", () => {
	assert.equal(utils.textToHtml("Hello\nWorld"), "<div>Hello<br>World</div>");
	assert.equal(utils.textToHtml("שלום\nעולם"), `<div ${RTL_ATTRIBUTES}>שלום<br>עולם</div>`);
	assert.equal(utils.textToHtml("שלום <b>"), `<div ${RTL_ATTRIBUTES}>שלום &lt;b&gt;</div>`);
	assert.equal(utils.textToHtml(""), "");
});

test("plain-text signatures keep their direction", () => {
	assert.equal(utils.signatureToHtml("Jane Doe\nAcme"), "Jane Doe<br>Acme");
	assert.equal(utils.signatureToHtml("רן נחמני\nמנכ\"ל"), `<div ${RTL_ATTRIBUTES}>רן נחמני<br>מנכ&quot;ל</div>`);
});

test("signature swaps still find a right-to-left signature block", () => {
	const withSignature = utils.applyMailboxSignatureHtml("<div>גוף</div>", null, "חתימה");
	assert.ok(withSignature.includes(`<div ${RTL_ATTRIBUTES}>חתימה</div>`));
	const swapped = utils.applyMailboxSignatureHtml(withSignature, "חתימה", "Signature");
	assert.ok(!swapped.includes("חתימה"));
	assert.ok(swapped.endsWith("<br><br>Signature</div>"));
});

test("left-to-right mail goes out without the composer's dir=auto markers", () => {
	assert.equal(
		utils.applyOutgoingTextDirection('<div dir="auto">Hello</div><ul dir="auto"><li dir="auto">One</li></ul>'),
		"<div>Hello</div><ul><li>One</li></ul>",
	);
	assert.equal(utils.applyOutgoingTextDirection("<div>Plain</div>"), "<div>Plain</div>");
});

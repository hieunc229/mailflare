import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-readable-text-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { r: join(root, "src/lib/email/reply-content-utils.ts"), p: join(root, "src/lib/email/parse.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { htmlToReadableText } = await import(pathToFileURL(join(dir, "r.mjs")).href);
const { buildSnippet } = await import(pathToFileURL(join(dir, "p.mjs")).href);

test("numeric character references are decoded", () => {
	assert.equal(htmlToReadableText("<p>We&#8217;re open &#x2014; it&#39;s &#X27;on&#x27;</p>").trim(), "We’re open — it's 'on'");
});

test("each entity is decoded once, so escaped markup stays text", () => {
	assert.equal(htmlToReadableText("<p>Write &amp;lt;b&amp;gt; for bold &amp;amp; more</p>").trim(), "Write &lt;b&gt; for bold &amp; more");
	assert.equal(htmlToReadableText("<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot;&nbsp;&apos;n&apos; crackers</p>").trim(), "Tom & Jerry <3 \"cheese\" 'n' crackers");
});

test("unknown names and out-of-range code points are left as they are", () => {
	assert.equal(htmlToReadableText("<p>&bogus; &#0; &#x110000; &#xD800;</p>").trim(), "&bogus; &#0; &#x110000; &#xD800;");
});

test("the snippet of an HTML-only message shows decoded text", () => {
	assert.equal(buildSnippet(null, "<div>Hi Sam,</div><div>It&#8217;s ready &#8212; see &amp;lt;attached&amp;gt;.</div>"), "Hi Sam, It’s ready — see &lt;attached&gt;.");
});

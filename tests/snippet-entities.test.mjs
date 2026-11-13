import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-snippet-entities-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { buildSnippet } from "./src/lib/email/parse.ts";
			export { htmlToReadableText } from "./src/lib/email/reply-content-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "snippet-entities-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
	banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
const { buildSnippet, htmlToReadableText } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const snippet = (html) => buildSnippet(null, html);

test("snippets decode numeric and common named entities", () => {
	assert.equal(snippet("Don&#8217;t miss&hellip; &#x1F600; &copy;"), "Don’t miss… \u{1F600} ©");
	assert.equal(snippet("a&nbsp;b &quot;c&quot; &#39;d&#39;"), "a b \"c\" 'd'");
});

test("an escaped entity in a snippet is decoded once, not twice", () => {
	assert.equal(snippet("&amp;lt;b&amp;gt; &amp;amp;"), "&lt;b&gt; &amp;");
});

test("unknown or invalid entities in a snippet are left as written", () => {
	assert.equal(snippet("&bogus; &#0; &#xD800; &#99999999; AT&T"), "&bogus; &#0; &#xD800; &#99999999; AT&T");
});

test("the shared htmlToReadableText keeps its small named-entity set for other callers", () => {
	assert.equal(htmlToReadableText("Don&#8217;t &hellip; &amp;lt;"), "Don\u2019t &hellip; &lt;");
});

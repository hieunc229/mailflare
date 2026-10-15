import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
	entryPoints: ["src/lib/email/note-html.ts"],
	bundle: true,
	write: false,
	platform: "node",
	format: "esm",
});
const { sanitizeNoteHtml } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("plain text is escaped and line breaks become br", () => {
	assert.equal(sanitizeNoteHtml("Tom & Jerry\nline 2"), "<div>Tom &amp; Jerry<br>line 2</div>");
});

test("empty and whitespace-only notes are cleared", () => {
	assert.equal(sanitizeNoteHtml("  \n"), "");
	assert.equal(sanitizeNoteHtml("<p> <br> </p>"), "");
});

test("script, style, and iframe contents are dropped", () => {
	const html = sanitizeNoteHtml('<style>body{color:red}</style><script>alert(1)</script><iframe src="https://evil.example">secret</iframe><p>kept</p>');
	assert.match(html, /<p>kept<\/p>/);
	assert.doesNotMatch(html, /alert|secret|evil\.example|<style|<script|<iframe/);
});

test("links keep http, https, mailto, and tel, and drop the rest", () => {
	const html = sanitizeNoteHtml([
		'<a href="https://example.com/a">https</a>',
		'<a href="http://example.com/b">http</a>',
		'<a href="mailto:ada@example.com">mail</a>',
		'<a href="tel:+441234">tel</a>',
		'<a href="javascript:alert(1)">js</a>',
		'<a href="/relative">rel</a>',
		'<a href="data:text/html,hi">data</a>',
	].join(""));
	assert.match(html, /href="https:\/\/example\.com\/a"/);
	assert.match(html, /href="http:\/\/example\.com\/b"/);
	assert.match(html, /href="mailto:ada@example\.com"/);
	assert.match(html, /href="tel:\+441234"/);
	assert.doesNotMatch(html, /javascript:|href="\/relative"|data:text/);
	// The words stay. The unsafe address does not.
	assert.match(html, /tel<\/a>jsreldata$/);
});

test("event handlers and unexpected attributes are not stored", () => {
	const html = sanitizeNoteHtml('<div onclick="alert(1)"><a href="https://example.com" onclick="alert(2)" target="_blank">go</a><img src="x" onerror="alert(3)"></div>');
	assert.equal(html, '<div><a href="https://example.com/" rel="noopener noreferrer" target="_blank">go</a></div>');
});

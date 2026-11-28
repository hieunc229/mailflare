import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "https://mail.example/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
const bundle = await build({ entryPoints: ["src/lib/email/html.ts"], bundle: true, write: false, platform: "browser", format: "esm" });
const { prepareEmailHtml, resolveEmailCidUrls, sanitizeEditorHtml } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const message = `<html><head><style>
@import "https://remote.example/import.css";
@media (max-width:600px) { body .card { color:red; background:url(https://remote.example/bg); } }
@font-face {font-family:Mail;src:url(https://remote.example/font.woff2)}
.other { background:image-set("https://remote.example/set" 1x); }
:host {display:none}
</style></head><body bgcolor="#eee"><div class="card" style="display:grid;gap:12px">Hello</div>
<img src="https://remote.example/image" srcset="https://remote.example/large 2x" onerror="alert(1)">
<img src="/api/messages/m/attachments/a?preview=1"><script>alert(1)</script>
<a href="javascript:alert(1)">bad</a></body></html>`;

test("reader preserves layout and local attachments but blocks every remote URL", () => {
	const result = prepareEmailHtml(message, { reader: true });
	assert.equal(result.hasRemote, true);
	assert.doesNotMatch(result.html, /remote\.example|onerror|<script|javascript:|:host|@import/);
	assert.match(result.html, /@media/);
	assert.match(result.html, /display:grid/);
	assert.match(result.html, /class="card"/);
	assert.match(result.html, /\/api\/messages\/m\/attachments\/a\?preview=1/);
});

test("authorization restores images, srcset, CSS backgrounds and fonts", () => {
	const result = prepareEmailHtml(message, { reader: true, allowRemote: true });
	for (const path of ["image", "large", "bg", "font.woff2", "set"]) assert.ok(result.html.includes(`https://remote.example/${path}`));
	assert.doesNotMatch(result.html, /@import|:host|onerror|<script/);
});

test("CSS escaping cannot bypass remote blocking", () => {
	const result = prepareEmailHtml('<style>.x{background:u\\72l(https://remote.example/escaped)}</style><div class="x">x</div>', { reader: true });
	assert.doesNotMatch(result.html, /remote\.example/);
});

test("outgoing quotes retain styles and remote addresses without document tags", () => {
	const result = prepareEmailHtml(message, { forOutgoing: true });
	assert.doesNotMatch(result.html, /onerror|javascript:|<html|<body/);
	assert.match(result.html, /<style/);
	assert.match(result.html, /https:\/\/remote.example\/image/);
});

test("CID mapping changes resource attributes and CSS, not visible text", () => {
	const source = '<style>.x{background:url(cid:logo)}</style><img src="CID:logo"><p>cid:logo</p>';
	const resolved = resolveEmailCidUrls(source, new Map([["logo", "/api/messages/m/attachments/a?preview=1"]]));
	assert.match(resolved, /<p>cid:logo<\/p>/);
	const result = prepareEmailHtml(resolved, { reader: true });
	assert.equal(result.hasRemote, false);
	assert.equal((result.html.match(/\/api\/messages\/m\/attachments\/a/g) ?? []).length, 2);
});

test("escaped function names and URLs cannot bypass resource policy", () => {
	for (const value of [String.raw`im\61ge-set("https://remote.example/set" 1x)`, String.raw`-webkit-im\61ge-set("https://remote.example/set" 1x)`, String.raw`u\72l("https://remote.example/bg")`, String.raw`image("https://remote.example/bg")`]) {
		const source = `<style>.x{background:${value}}</style><p class="x">x</p>`;
		const blocked = prepareEmailHtml(source, { reader: true });
		assert.doesNotMatch(blocked.html, /remote\.example/, value);
		assert.equal(blocked.hasRemote, true, value);
		assert.match(prepareEmailHtml(source, { reader: true, allowRemote: true }).html, /remote\.example/);
	}
});

test("escaped shadow boundary selectors are removed without removing normal selectors", () => {
	const source = String.raw`<style>:h\6fst{display:none}:host-context(.x){color:red}::p\61rt(x){color:blue}.x{color:green}</style><p class="x">x</p>`;
	const result = prepareEmailHtml(source, { reader: true });
	assert.doesNotMatch(result.html, /h\\6fst|host-context|p\\61rt/);
	assert.match(result.html, /\.x\{color:green\}/);
});

test("CSS variables, keyframes and layers survive and URLs inside variables are handled", () => {
	const source = '<style>:root{--brand:red;--image:url(https://remote.example/bg)}@layer mail{.x{color:var(--brand);background:var(--image)}}@keyframes spin{to{transform:rotate(1turn)}}</style><p style="color:red;--brand:blue;font-size:20px">x</p>';
	const result = prepareEmailHtml(source, { reader: true });
	assert.match(result.html, /--brand:red/);
	assert.match(result.html, /@layer mail/);
	assert.match(result.html, /@keyframes spin/);
	assert.match(result.html, /color:red;--brand:blue;font-size:20px/);
	assert.doesNotMatch(result.html, /remote\.example/);
});

test("invalid declaration does not erase unrelated valid declarations", () => {
	const result = prepareEmailHtml('<style>.x{color:red;background:url("broken);font-size:20px}.y{color:green}</style>', { reader: true });
	assert.match(result.html, /color:red/);
});

test("document attributes, body backgrounds and structural selectors are preserved", () => {
	const source = '<html dir="rtl" class="original-root" style="font-size:20px"><head><style>html.original-root > body.original-body{padding:10px}:root{--brand:red}</style></head><body class="original-body" bgcolor="#ff0000" background="https://remote.example/bg"><p>x</p></body></html>';
	const result = prepareEmailHtml(source, { reader: true });
	const template = document.createElement("template");
	template.innerHTML = result.html;
	const root = template.content.querySelector(result.rootTag);
	const body = root.querySelector(result.bodyTag);
	assert.equal(root.getAttribute("dir"), "rtl");
	assert.equal(root.style.fontSize, "20px");
	assert.equal(root.className, "original-root");
	assert.equal(body.style.backgroundColor, "rgb(255, 0, 0)");
	assert.match(result.html, new RegExp(`${result.rootTag}\\.original-root>${result.bodyTag}\\.original-body`));
	assert.doesNotMatch(result.html, /remote\.example/);
});

test("CID conversion preserves document metadata and does not rewrite text resembling tags", () => {
	const source = '<html dir="rtl"><head><style>.x:before{content:"<body>"}</style></head><body bgcolor="#eee"><img src="cid:logo"></body></html>';
	const resolved = resolveEmailCidUrls(source, new Map([["logo", "/api/messages/m/attachments/a?preview=1"]]));
	assert.match(resolved, /<html dir="rtl">/);
	assert.match(resolved, /content:"<body>"/);
	assert.match(resolved, /<body bgcolor="#eee">/);
});

test("reader containers do not share class names with message content", () => {
	const result = prepareEmailHtml('<style>.mail-root{display:none}</style><div class="mail-document">x</div>', { reader: true });
	const template = document.createElement("template");
	template.innerHTML = result.html;
	assert.equal(template.content.querySelector(result.rootTag).className, "");
	assert.equal(template.content.querySelector(result.bodyTag).className, "");
});

test("fragment links retain IDs and do not open another document", () => {
	const result = prepareEmailHtml('<a href="#section">jump</a><p id="section">x</p>', { reader: true });
	assert.match(result.html, /href="#section"/);
	assert.doesNotMatch(result.html, /target="_blank"/);
	assert.match(result.html, /id="section"/);
});

test("editor preview blocks resources, preserves them for send and is stable on roundtrip", () => {
	const source = '<p style="color:red;--brand:blue;background:url(https://remote.example/bg)">x<img src="https://remote.example/image" srcset="https://remote.example/large 2x"></p>';
	const preview = sanitizeEditorHtml(source);
	const template = document.createElement("template");
	template.innerHTML = preview;
	assert.equal(template.content.querySelector("img").getAttribute("src"), null);
	assert.equal(template.content.querySelector("img").getAttribute("srcset"), null);
	assert.doesNotMatch(template.content.querySelector("p").getAttribute("style"), /remote\.example/);
	const outgoing = prepareEmailHtml(preview, { forOutgoing: true }).html;
	for (const path of ["image", "large", "bg"]) assert.ok(outgoing.includes(`https://remote.example/${path}`));
	assert.doesNotMatch(outgoing, /data-mailflare-(?:src|style)/);
	assert.equal(sanitizeEditorHtml(outgoing), preview);
});

test("editor preview never includes stylesheets or loses signature markers", () => {
	const result = sanitizeEditorHtml('<style>body{display:none}</style><div data-mailflare-signature="1">signature</div>');
	assert.doesNotMatch(result, /<style/);
	assert.match(result, /data-mailflare-signature="1"/);
});

test("ordinary outgoing fragments do not acquire wrappers on each edit", () => {
	const first = prepareEmailHtml('<p><b>hello</b></p>', { forOutgoing: true }).html;
	assert.equal(first, '<p><b>hello</b></p>');
	assert.equal(prepareEmailHtml(first, { forOutgoing: true }).html, first);
});

test("string variables cannot indirectly trigger image-set requests before authorization", () => {
	const source = '<style>:root{--image:"https://remote.example/variable"}.x{background:image-set(var(--image) 1x)}</style><p class="x">x</p>';
	const blocked = prepareEmailHtml(source, { reader: true });
	assert.equal(blocked.hasRemote, true);
	assert.doesNotMatch(blocked.html, /background:image-set/);
	assert.match(prepareEmailHtml(source, { reader: true, allowRemote: true }).html, /background:image-set/);
});

test("resource placeholders do not revert unrelated formatting edits", () => {
	const preview = sanitizeEditorHtml('<p style="color:red;background:url(https://remote.example/bg)">x</p>');
	const template = document.createElement("template");
	template.innerHTML = preview;
	template.content.querySelector("p").style.color = "blue";
	const outgoing = prepareEmailHtml(template.innerHTML, { forOutgoing: true }).html;
	assert.match(outgoing, /color:blue/);
	assert.match(outgoing, /remote\.example\/bg/);
});

test("CID mapping does not discard the base URL used by relative resources", () => {
	const source = '<html><head><base href="https://remote.example/assets/"></head><body><img src="logo.png"><img src="cid:logo"></body></html>';
	const resolved = resolveEmailCidUrls(source, new Map([["logo", "/api/messages/m/attachments/a?preview=1"]]));
	const blocked = prepareEmailHtml(resolved, { reader: true });
	assert.equal(blocked.hasRemote, true);
	assert.doesNotMatch(blocked.html, /remote\.example/);
	assert.match(prepareEmailHtml(resolved, { reader: true, allowRemote: true }).html, /https:\/\/remote\.example\/assets\/logo.png/);
});

test("styled signatures are deterministic and editor copies are inert but exportable", () => {
	const source = '<style>.signature{color:red;background:url(https://remote.example/bg)}</style><p class="signature">signature</p>';
	const outgoing = prepareEmailHtml(source, { forOutgoing: true }).html;
	assert.equal(prepareEmailHtml(source, { forOutgoing: true }).html, outgoing);
	const preview = sanitizeEditorHtml(outgoing);
	assert.doesNotMatch(preview, /<style/);
	assert.match(preview, /data-mailflare-sheet/);
	assert.match(prepareEmailHtml(preview, { forOutgoing: true }).html, /\.signature\{color:red;background:url\(https:\/\/remote.example\/bg\)/);
	assert.equal(sanitizeEditorHtml(prepareEmailHtml(preview, { forOutgoing: true }).html), preview);
});

test("sanitizing twice gives identical output and still strips scripts", () => {
	const html = '<p onclick="x()">a</p><script>alert(1)</script>';
	const first = sanitizeEditorHtml(html);
	assert.equal(sanitizeEditorHtml(html), first);
	assert.ok(!/script|onclick/i.test(first), first);
});

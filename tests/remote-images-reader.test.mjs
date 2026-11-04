import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "https://mail.example/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
const bundle = await build({ entryPoints: ["src/lib/remote-images/reader.ts"], bundle: true, write: false, platform: "browser", format: "esm" });
const { prepareReaderEmailHtml } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const endpoint = url => `/api/remote-images?url=${encodeURIComponent(url)}`;

const source = `<style>.hero{background:url(https://cdn.example/bg.png)}.retina{background:image-set("https://cdn.example/retina.png" 2x)}</style>
<img src="https://cdn.example/logo.gif" srcset="https://cdn.example/small.png 1x, https://cdn.example/large.png 2x">
<div background="https://cdn.example/background.png" style="background-image:url(https://cdn.example/inline.png)">Mail</div>
<img src="/api/messages/m/attachments/a?preview=1"><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
<a href="https://example.com/help">Help</a><script>alert(1)</script>`;

test("blocked remote content never creates proxy requests", () => {
	const result = prepareReaderEmailHtml(source, { reader: true, allowRemote: false });
	assert.equal(result.hasRemote, true);
	assert.doesNotMatch(result.html, /\/api\/remote-images/);
	assert.doesNotMatch(result.html, /https:\/\/cdn\.example/);
});

test("allowed raster resources, srcset and CSS image URLs use the authenticated proxy", () => {
	const result = prepareReaderEmailHtml(source, { reader: true, allowRemote: true });
	for (const file of ["logo.gif", "small.png", "large.png", "bg.png", "retina.png", "inline.png"]) {
		assert.ok(result.html.includes(endpoint(`https://cdn.example/${file}`)), file);
	}
	assert.ok(result.html.includes("/api/messages/m/attachments/a?preview=1"));
	assert.ok(result.html.includes("data:image/gif;base64,"));
	assert.ok(result.html.includes('href="https://example.com/help"'));
	assert.doesNotMatch(result.html, /<script/);
});

test("blocking the same message again removes proxy resources", () => {
	const allowed = prepareReaderEmailHtml(source, { reader: true, allowRemote: true });
	assert.match(allowed.html, /\/api\/remote-images/);
	const blocked = prepareReaderEmailHtml(source, { reader: true, allowRemote: false });
	assert.doesNotMatch(blocked.html, /\/api\/remote-images/);
});

test("shared CSS variables keep their original text value for non-image uses", () => {
	const html = '<style>:root{--shared:"https://cdn.example/shared.png"}.image{background:image-set(var(--shared) 1x)}.text{content:var(--shared)}</style>';
	const result = prepareReaderEmailHtml(html, { reader: true, allowRemote: true });
	assert.ok(result.html.includes(endpoint("https://cdn.example/shared.png")));
	assert.match(result.html, /--shared:"https:\/\/cdn\.example\/shared\.png"/);
	assert.match(result.html, /content:var\(--shared\)/);
	assert.match(result.html, /image-set\(var\(--mailflare-image-/);
});

test("image-valued properties proxy strings through nested custom properties", () => {
	const html = '<style>:root{--src:"https://cdn.example/chain.png";--img:image-set(var(--src) 1x);--text:"https://cdn.example/text.png"}.hero{background-image:var(--img);content:var(--text)}</style><div class="hero">Mail</div>';
	const result = prepareReaderEmailHtml(html, { reader: true, allowRemote: true });
	assert.ok(result.html.includes(endpoint("https://cdn.example/chain.png")));
	assert.match(result.html, /background-image:var\(--mailflare-image-/);
	assert.match(result.html, /--img:image-set\(var\(--src\) 1x\)/);
	assert.match(result.html, /content:var\(--text\)/);
	assert.ok(!result.html.includes(endpoint("https://cdn.example/text.png")));
});

test("CSS custom-property image strings and fallbacks use the authenticated proxy", () => {
	const html = `<style>:root{--image:"https://cdn.example/variable.png";--chain:var(--image);--unrelated:"https://cdn.example/text.png"}
	.hero{background:image-set(var(--chain) 1x,var(--missing,"https://cdn.example/fallback.png") 2x);content:var(--unrelated)}
	.cross{background:image-set(var(--cross) 1x)}</style>
	<div class="hero cross" style="--cross:'https://cdn.example/cross.png';--inline:'https://cdn.example/inline-variable.png';background-image:image-set(var(--inline) 1x)">Mail</div>`;
	const result = prepareReaderEmailHtml(html, { reader: true, allowRemote: true });
	for (const file of ["variable.png", "fallback.png", "cross.png", "inline-variable.png"]) {
		assert.ok(result.html.includes(endpoint(`https://cdn.example/${file}`)), file);
	}
	assert.match(result.html, /https:\/\/cdn\.example\/text\.png/);
	assert.ok(!result.html.includes(endpoint("https://cdn.example/text.png")));
	assert.match(result.html, /image-set\(var\(--mailflare-image-/);
	assert.doesNotMatch(result.html, /image-set\(var\(--chain\)/);
});

test("self-hosted rendering preserves permitted direct URLs without an unsupported proxy", () => {
	const result = prepareReaderEmailHtml(source, { reader: true, allowRemote: true, proxyRemote: false });
	assert.doesNotMatch(result.html, /\/api\/remote-images/);
	assert.match(result.html, /https:\/\/cdn\.example\/logo.gif/);
	assert.doesNotMatch(result.html, /<script/);
});

test("remote font sources are dropped while CSS raster images use the image proxy", () => {
	const html = '<style>@font-face{font-family:mail;src:url(https://cdn.example/font.woff2) format("woff2")}.hero{background-image:url(https://cdn.example/bg.png)}</style><div class="hero">Mail</div>';
	const result = prepareReaderEmailHtml(html, { reader: true, allowRemote: true });
	assert.ok(!result.html.includes("font.woff2"), "a remote font would bypass the proxy");
	assert.ok(result.html.includes(endpoint("https://cdn.example/bg.png")));
	assert.ok(!result.html.includes(endpoint("https://cdn.example/font.woff2")));
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-shared-404-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/email/shared-file-unavailable.ts")], outfile: join(outDir, "page.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") } });
const { pickPageLocale, sharedFileUnavailable } = await import(pathToFileURL(join(outDir, "page.mjs")).href);
const catalog = (code) => JSON.parse(readFileSync(join(root, "public/locales", `${code}.json`), "utf8"));

test("a dead link is a 404 HTML page that says why and what to do", async () => {
	const response = sharedFileUnavailable("en", undefined);
	assert.equal(response.status, 404);
	assert.match(response.headers.get("content-type"), /^text\/html; charset=utf-8/);
	const html = await response.text();
	assert.match(html, /<html lang="en" dir="ltr">/);
	assert.match(html, /<h1>This download link is no longer available<\/h1>/);
	assert.match(html, /Ask the sender to share the file again/);
});

test("expired, trashed and unknown links look identical, and the page is not cacheable, indexable or scriptable", async () => {
	const response = sharedFileUnavailable("en", undefined);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
	assert.doesNotMatch(response.headers.get("content-security-policy"), /script-src/);
	assert.equal(response.headers.get("x-robots-tag"), "noindex");
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	assert.doesNotMatch(await response.text(), /<script|share_|filename/i);
});

test("the page is translated and flips direction for right-to-left languages", async () => {
	const html = await sharedFileUnavailable("ar", catalog("ar")).text();
	assert.match(html, /<html lang="ar" dir="rtl">/);
	assert.match(html, new RegExp(catalog("ar")["sharedFile.unavailable.title"]));
});

test("the locale comes from the cookie, then Accept-Language, else English", () => {
	assert.equal(pickPageLocale("mailflare-locale=de", "fr"), "de");
	assert.equal(pickPageLocale(null, "fr-CH, fr;q=0.9, en;q=0.8"), "fr");
	assert.equal(pickPageLocale(null, "pt-br"), "pt-BR");
	assert.equal(pickPageLocale(null, "pt"), "pt-BR");
	assert.equal(pickPageLocale("mailflare-locale=xx", "xx-YY"), "en");
	assert.equal(pickPageLocale(null, null), "en");
});

test("the route returns the page for every dead-link branch", () => {
	const route = readFileSync(join(root, "src/app/api/shared-files/[id]/route.ts"), "utf8");
	assert.doesNotMatch(route, /Link expired or not found|File not found/);
	assert.equal(route.match(/return unavailable\(/g)?.length, 2);
});

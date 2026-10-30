import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-i18n-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const outfile = join(outDir, "i18n.mjs");

// Catalogs other than English are static assets; tests serve them from public/ for both the browser
// `fetch` and the server's ASSETS binding. `testCatalogs` adds in-memory catalogs for an isolated locale.
globalThis.testCatalogs = {};
globalThis.readTestAsset = async (input) => {
	const path = new URL(String(input), "https://mailflare.local").pathname;
	const code = path.match(/^\/locales\/([\w-]+)\.json$/)?.[1];
	if (code && globalThis.testCatalogs[code]) return Response.json(globalThis.testCatalogs[code]);
	const file = join(root, "public", path);
	return existsSync(file) ? new Response(readFileSync(file)) : new Response("Not found", { status: 404 });
};
globalThis.fetch = globalThis.readTestAsset;

async function bundleI18n(outfile, extraLocale = false) {
	await build({
		stdin: {
			contents: `
				import { createElement } from "react";
				import { renderToStaticMarkup } from "react-dom/server";
				import RootLayout from "./src/app/layout";
				import { LanguageProvider, useLanguage } from "./src/components/language-provider";
				import { LanguageSelector } from "./src/components/language-selector";
				import { loadMessages } from "./src/lib/i18n/utils";
				export * from "./src/lib/i18n/utils";
				export * from "./src/lib/i18n/locales";
				function Probe() { return createElement("span", null, useLanguage().t("navigation.inbox")); }
				export async function renderLanguage(locale) {
					const initialMessages = await loadMessages(locale);
					return renderToStaticMarkup(createElement(LanguageProvider, { initialLocale: locale, initialMessages }, createElement(Probe), createElement(LanguageSelector)));
				}
				export async function renderLayout(cookieValue) {
					globalThis.testLocaleCookie = cookieValue;
					return renderToStaticMarkup(await RootLayout({ children: createElement(Probe) }));
				}
			`,
			resolveDir: root,
			loader: "tsx",
		},
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
		plugins: [{
			name: "layout-runtime-stubs",
			setup(builder) {
				if (extraLocale) builder.onLoad({ filter: /\/i18n\/locales\.ts$/ }, ({ path }) => ({
					contents: readFileSync(path, "utf8").replace("export const locales = {", `export const locales = {
						xx: { label: "Testlandic", dir: "rtl" },`),
					loader: "ts",
				}));
				builder.onResolve({ filter: /^(next\/headers|next\/font\/google|@\/components\/providers|@\/lib\/cloudflare|\.\/home-server-utils)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
				builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({ contents: path === "next/headers"
					? 'export async function cookies() { return { get(name) { return name === "mailflare-locale" && globalThis.testLocaleCookie !== undefined ? { value: globalThis.testLocaleCookie } : undefined; } }; }'
					: path === "next/font/google"
						? 'export const Geist = () => ({ variable: "sans" }); export const Geist_Mono = () => ({ variable: "mono" });'
						: path === "./home-server-utils"
							? 'export async function getHomeBranding() { return { appName: "Mailflare", hasCustomIcon: false, canCustomizeBranding: false }; }'
							: path === "@/lib/cloudflare"
								? "export function getEnv() { return { ASSETS: { fetch: globalThis.readTestAsset } }; }"
							: 'export function Providers({ children }) { return children; }' }));
				builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
			},
		}],
	});
}
await bundleI18n(outfile);

const i18n = await import(pathToFileURL(outfile).href);
const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));

const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const categoryOf = (key) => CATEGORIES.find((category) => key.endsWith(`.${category}`));
const baseOf = (key) => categoryOf(key) ? key.slice(0, key.lastIndexOf(".")) : key;
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
// A plural group is `base.other` plus any other CLDR categories; catalogs may carry the categories their language needs.
const pluralBases = new Set(Object.keys(en).filter((key) => key.endsWith(".other")).map(baseOf));
const isPluralKey = (key) => categoryOf(key) && pluralBases.has(baseOf(key));

test("every registered catalog has the English keys and nonempty messages and label", async () => {
	for (const [code, { label }] of Object.entries(i18n.locales)) {
		const catalog = await i18n.loadMessages(code);
		assert.ok(label.trim().length > 0, code);
		const plain = (keys) => keys.filter((key) => !isPluralKey(key)).sort();
		assert.deepEqual(plain(Object.keys(catalog)), plain(Object.keys(en)), `${code}: keys differ from English`);
		for (const base of pluralBases) assert.ok(typeof catalog[`${base}.other`] === "string", `${code}: ${base}.other is required`);
		for (const key of Object.keys(catalog)) {
			if (isPluralKey(key)) assert.ok(`${baseOf(key)}.other` in catalog, `${code}: ${key} has no .other`);
			const value = catalog[key];
			assert.ok(typeof value === "string" && value.trim().length > 0, `${code}: ${key} is empty`);
			const reference = isPluralKey(key) ? en[`${baseOf(key)}.other`] : en[key];
			// A plural variant may drop {count} ("this message"), but never invent a placeholder.
			const allowed = placeholders(reference);
			const used = placeholders(value);
			if (isPluralKey(key)) assert.ok(used.every((name) => allowed.includes(name)), `${code}: ${key} uses an unknown {placeholder}`);
			else assert.deepEqual(used, allowed, `${code}: ${key} changes its {placeholders}`);
		}
	}
});

test("missing, invalid and unsupported locale values fall back to English", () => {
	for (const value of [undefined, null, "", "not-a-registered-locale", "pt-BR; Path=/", {}]) assert.equal(i18n.resolveLocale(value), "en");
	assert.equal(i18n.resolveLocale("en"), "en");
	assert.equal(i18n.resolveLocale("pt-BR"), "pt-BR");
});

test("translation uses the requested catalog and falls back per key", async () => {
	assert.equal(i18n.translate(await i18n.loadMessages("pt-BR"), "navigation.inbox"), "Entrada");
	assert.equal(i18n.translate({}, "navigation.inbox"), "Inbox");
});

test("existing locale-specific plural translations remain available", async () => {
	const catalog = await i18n.loadMessages("pl");
	assert.equal(catalog["thread.attachmentCount.few"], "{count} załączniki");
	assert.equal(i18n.createTranslator("pl", catalog)("thread.attachmentCount", { count: 3 }), "3 załączniki");
});

test("preference cookie persists for a year, covers every path and is Secure on HTTPS", () => {
	assert.equal(i18n.serializeLocaleCookie("pt-BR", true), "mailflare-locale=pt-BR; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
	assert.equal(i18n.serializeLocaleCookie("en", false), "mailflare-locale=en; Path=/; Max-Age=31536000; SameSite=Lax");
	assert.equal(i18n.serializeLocaleCookie("bad; Domain=example.com", true), "mailflare-locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
});

test("provider server rendering uses initial locale and labels the native language selector", async () => {
	const pt = await i18n.renderLanguage("pt-BR");
	assert.match(pt, /<span>Entrada<\/span>/);
	assert.match(pt, /<label for="[^"]+"[^>]*>Idioma<\/label>/);
	assert.match(pt, /<select id="[^"]+"/);
	assert.match(pt, /value="pt-BR" lang="pt-BR" selected=""/);
	assert.match(await i18n.renderLanguage("en"), /value="en" lang="en" selected=""/);
});

test("root layout passes the same cookie locale to HTML and provider on first render", async () => {
	const pt = await i18n.renderLayout("pt-BR");
	assert.match(pt, /<html lang="pt-BR"/);
	assert.match(pt, /<span>Entrada<\/span>/);
	for (const value of [undefined, "bad"]) {
		const english = await i18n.renderLayout(value);
		assert.match(english, /<html lang="en"/);
		assert.match(english, />Inbox<\/span>/);
	}
});

test("a locale registered once reaches resolution, translation, cookie, selector and SSR", async () => {
	assert.ok(existsSync(join(root, "src/lib/i18n/locales.ts")), "locales must have one shared registry");
	globalThis.testCatalogs.xx = { ...en, "navigation.inbox": "Entrada", "navigation.inbox.one": "{count} entrada", "navigation.inbox.other": "{count} entradas", "language.label": "Idioma" };
	const extraFile = join(outDir, "with-spanish.mjs");
	await bundleI18n(extraFile, true);
	const extended = await import(pathToFileURL(extraFile).href);
	assert.equal(extended.resolveLocale("xx"), "xx");
	assert.equal(extended.translate(await extended.loadMessages("xx"), "navigation.inbox"), "Entrada");
	assert.match(extended.serializeLocaleCookie("xx", true), /^mailflare-locale=xx;/);
	const selector = await extended.renderLanguage("xx");
	assert.match(selector, /value="xx" lang="xx" selected="">Testlandic<\/option>/);
	assert.match(selector, />Entrada<\/span>/);
	const layout = await extended.renderLayout("xx");
	assert.match(layout, /<html lang="xx"/);
	assert.match(layout, />Entrada<\/span>/);
	assert.match(layout, /<html lang="xx" dir="rtl"/);
	const t = extended.createTranslator("xx", await extended.loadMessages("xx"));
	assert.equal(t("navigation.inbox", { count: 1 }), "1 entrada");
	assert.equal(t("navigation.inbox", { count: 3 }), "3 entradas");
	assert.equal(t("navigation.inbox"), "Entrada");
	for (const invalid of ["constructor", "toString", "__proto__"]) {
		assert.equal(extended.resolveLocale(invalid), "en");
	}
});

test("translations interpolate {vars}, keep unknown placeholders and default to ltr", async () => {
	assert.equal(i18n.translate({ "navigation.inbox": "Hi {name}, {other}" }, "navigation.inbox", { name: "Ana", count: 2 }), "Hi Ana, {other}");
	assert.equal(i18n.translate({}, "navigation.inbox", { name: "x" }), "Inbox");
	assert.equal(i18n.createTranslator("pt-BR", await i18n.loadMessages("pt-BR"))("navigation.inbox", { count: 2 }), "Entrada");
	assert.equal(i18n.getDirection("en"), "ltr");
});

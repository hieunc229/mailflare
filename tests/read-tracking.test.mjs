import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-read-tracking-bundle-"));
await build({
	stdin: {
		contents: `export * from "./src/lib/tracking/open-tracking-utils.ts";`,
		resolveDir: root,
		sourcefile: "read-tracking-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const tracking = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
rmSync(bundleDirectory, { recursive: true, force: true });

const sentAt = new Date("2026-10-23T10:00:00Z");
const later = new Date("2026-10-23T10:05:00Z");
const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("tokens are URL-safe and round-trip through the pixel path", () => {
	const token = tracking.createTrackingToken();
	assert.match(token, /^[A-Za-z0-9_-]{24}$/);
	assert.equal(tracking.parseTrackingToken(`${token}.gif`), token);
	assert.equal(tracking.parseTrackingToken(token), token);
	assert.equal(tracking.parseTrackingToken("../etc.gif"), null);
	assert.equal(tracking.buildTrackingPixelUrl("https://mail.example.com/", token), `https://mail.example.com/api/i/${token}.gif`);
});

test("APP_URL wins over the request origin and non-HTTP origins are refused", () => {
	assert.equal(tracking.resolveTrackingOrigin("https://mail.example.com/app", "http://localhost:3000"), "https://mail.example.com");
	assert.equal(tracking.resolveTrackingOrigin(undefined, "http://localhost:3000"), "http://localhost:3000");
	assert.equal(tracking.resolveTrackingOrigin("ftp://x", undefined), null);
	assert.equal(tracking.resolveTrackingOrigin(" ", undefined), null);
});

test("a domain's pixel host must be that domain or one of its subdomains", () => {
	assert.deepEqual(tracking.normalizeTrackingHost(" HTTPS://Mail.Kyburz.Email/ ", "kyburz.email"), { hostname: "mail.kyburz.email" });
	assert.deepEqual(tracking.normalizeTrackingHost("kyburz.email.", "kyburz.email"), { hostname: "kyburz.email" });
	assert.deepEqual(tracking.normalizeTrackingHost("mail.techgarage.email", "kyburz.email"), { error: "outsideDomain" });
	assert.deepEqual(tracking.normalizeTrackingHost("evilkyburz.email", "kyburz.email"), { error: "outsideDomain" });
	assert.deepEqual(tracking.normalizeTrackingHost("-bad.kyburz.email", "kyburz.email"), { error: "invalid" });
	assert.deepEqual(tracking.normalizeTrackingHost("mail kyburz.email", "kyburz.email"), { error: "invalid" });
	assert.deepEqual(tracking.normalizeTrackingHost("", "kyburz.email"), { error: "invalid" });
});

test("the pixel goes inside <body> and its URL is attribute-escaped", () => {
	const url = "https://mail.example.com/api/i/abc.gif?a=1&b=\"2\"";
	const wrapped = tracking.injectTrackingPixel("<html><body><p>Hi</p></body></html>", url);
	assert.match(wrapped, /<p>Hi<\/p><img src="https:\/\/mail\.example\.com\/api\/i\/abc\.gif\?a=1&amp;b=&quot;2&quot;" width="1" height="1" alt=""[^>]*\/><\/body><\/html>$/);
	assert.ok(tracking.injectTrackingPixel("<p>Hi</p>", "https://x/i.gif").startsWith("<p>Hi</p><img "));
});

test("Apple Mail Privacy Protection fetches are automated and carry no device", () => {
	const byAsn = tracking.classifyOpen({ userAgent: iphoneSafari, asn: 714, country: "CH", city: "Zürich", sentAt, openedAt: later });
	assert.deepEqual(byAsn, { client: "Apple Mail", device: null, country: null, city: null, automated: true });
	assert.equal(tracking.classifyOpen({ userAgent: "Mozilla/5.0", sentAt, openedAt: later }).automated, true);
});

test("proxied clients reveal neither device nor location", () => {
	const gmail = tracking.classifyOpen({ userAgent: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", asn: 15169, country: "US", city: "Mountain View", sentAt, openedAt: later });
	assert.deepEqual(gmail, { client: "Gmail", device: null, country: null, city: null, automated: false });
});

test("direct fetches name client, device and location", () => {
	const outlook = tracking.classifyOpen({ userAgent: "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)", country: "CH", city: "Bern", sentAt, openedAt: later });
	assert.deepEqual(outlook, { client: "Outlook", device: "Windows", country: "CH", city: "Bern", automated: false });
	const appleMail = tracking.classifyOpen({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", sentAt, openedAt: later });
	assert.equal(appleMail.client, "Apple Mail");
	assert.equal(appleMail.device, "Mac");
	const browser = tracking.classifyOpen({ userAgent: iphoneSafari, country: "XX", sentAt, openedAt: later });
	assert.deepEqual(browser, { client: null, device: "iPhone", country: null, city: null, automated: false });
});

test("fetches within seconds of delivery count as scanner prefetches", () => {
	const quick = tracking.classifyOpen({ userAgent: iphoneSafari, sentAt, openedAt: new Date(sentAt.getTime() + 3_000) });
	assert.equal(quick.automated, true);
});

test("repeat fetches by the same client are folded into one open", () => {
	const previous = { openedAt: later, client: "Gmail", device: null };
	assert.equal(tracking.isDuplicateOpen(previous, { openedAt: new Date(later.getTime() + 5_000), client: "Gmail", device: null }), true);
	assert.equal(tracking.isDuplicateOpen(previous, { openedAt: new Date(later.getTime() + 60_000), client: "Gmail", device: null }), false);
	assert.equal(tracking.isDuplicateOpen(previous, { openedAt: new Date(later.getTime() + 5_000), client: "Outlook", device: "Windows" }), false);
	assert.equal(tracking.isDuplicateOpen(undefined, previous), false);
});

test("the pixel is a valid 1x1 GIF that is never cached", () => {
	assert.equal(new TextDecoder().decode(tracking.TRACKING_PIXEL_GIF.slice(0, 6)), "GIF89a");
	assert.match(tracking.TRACKING_PIXEL_HEADERS["Cache-Control"], /no-store/);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-spam-intelligence-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: [
			`export { analyzeAuthentication } from "./src/lib/spam/analyzers/authentication";`,
			`export { analyzeImpersonation } from "./src/lib/spam/analyzers/impersonation";`,
			`export { extractSenderIp, isLookalikeDomain, registrableDomain } from "./src/lib/spam/domain-utils";`,
			`export { ExternalSpamIntelligenceProvider } from "./src/lib/spam/providers/external";`,
			`export { readSesTrace } from "./src/lib/email/provider-trace";`,
			`export { parseSesNotification } from "./src/lib/aws/ses-notification";`,
			`export { getSpamIntelligenceConfig } from "./src/lib/spam/settings";`,
			`export { formatBrandLines, parseBrandLines } from "./src/app/(admin)/spam-filter/utils";`,
		].join("\n"),
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});

const spam = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const ids = (signals) => signals.map((signal) => signal.id).sort();
const encoder = new TextEncoder();

test("SES verdicts drive authentication signals and outrank headers in the message", () => {
	const forged = { "authentication-results": "mx.cloudflare.net; spf=pass dkim=pass dmarc=pass" };
	const signals = spam.analyzeAuthentication(forged, { spf: "PASS", dkim: "FAIL", dmarc: "FAIL", spam: "FAIL", virus: "PASS" });
	assert.deepEqual(ids(signals), ["dkim_failed", "dmarc_failed", "provider_spam_verdict", "spf_passed"]);
	assert.deepEqual(ids(spam.analyzeAuthentication({ "authentication-results": "attacker.example; dmarc=pass" })), []);
	assert.deepEqual(ids(spam.analyzeAuthentication(forged, { spf: undefined })), ["dkim_passed", "dmarc_passed", "spf_passed"]);
});

test("the SES notification carries its verdicts and keeps the topmost of repeated headers", () => {
	const notification = spam.parseSesNotification(JSON.stringify({
		notificationType: "Received",
		mail: { source: "a@example.com", headers: [{ name: "Received", value: "top" }, { name: "Received", value: "forged" }] },
		receipt: {
			recipients: ["me@example.org"],
			spfVerdict: { status: "PASS" }, dkimVerdict: { status: "GRAY" }, dmarcVerdict: { status: "FAIL" },
			spamVerdict: { status: "PASS" }, virusVerdict: { status: "PASS" },
			action: { type: "S3", bucketName: "b", objectKey: "k" },
		},
	}));
	assert.equal(notification.headers.received, "top");
	assert.deepEqual(notification.verdicts, { spf: "PASS", dkim: "GRAY", dmarc: "FAIL", spam: "PASS", virus: "PASS" });
});

test("only the leading SES header block is trusted for verdicts and the connecting IP", () => {
	const raw = (head) => encoder.encode(`${head}\r\nSubject: hi\r\n\r\nbody`).buffer;
	const trace = spam.readSesTrace(raw([
		"Return-Path: <a@example.com>",
		"Received: from mail.example.com (mail.example.com [203.0.113.9])",
		"\tby inbound-smtp.eu-west-1.amazonaws.com with SMTP id x; Fri, 23 Oct 2026 10:00:00 +0000 (UTC)",
		"X-SES-Spam-Verdict: FAIL",
		"X-SES-Virus-Verdict: PASS",
		"Received-SPF: pass",
		"Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=example.com; dkim=fail header.i=@example.com; dmarc=fail header.from=example.com;",
		"X-SES-RECEIPT: abc",
		"From: a@example.com",
		"X-SES-Spam-Verdict: PASS",
		"Authentication-Results: amazonses.com; dmarc=pass",
	].join("\r\n")));
	assert.equal(trace.senderIp, "203.0.113.9");
	assert.deepEqual(trace.verdicts, { spf: "PASS", dkim: "FAIL", dmarc: "FAIL", spam: "FAIL", virus: "PASS" });

	const noReceipt = spam.readSesTrace(raw("Authentication-Results: amazonses.com; dmarc=pass\r\nX-SES-Spam-Verdict: PASS"));
	assert.deepEqual(noReceipt, {});
	const afterOther = spam.readSesTrace(raw("From: a@example.com\r\nX-SES-RECEIPT: abc\r\nAuthentication-Results: amazonses.com; dmarc=pass"));
	assert.deepEqual(afterOther, {});
});

test("the sending IP comes from the topmost Received hop and skips private addresses", () => {
	const received = "from mx (mx [10.0.0.4]) by mx.cloudflare.net; Fri, 23 Oct 2026 10:00:00 +0000, from evil ([198.51.100.7]) by x; Fri, 23 Oct 2026 09:00:00 +0000";
	assert.equal(spam.extractSenderIp({ received }), null);
	assert.equal(spam.extractSenderIp({ Received: "from a (a [192.0.2.44]) by mx.cloudflare.net; Fri, 23 Oct 2026" }), "192.0.2.44");
});

test("lookalike domains and brand display names are flagged, real senders are not", () => {
	assert.equal(spam.registrableDomain("mail.shop.example.co.uk"), "example.co.uk");
	assert.equal(spam.isLookalikeDomain("paypa1.com", "paypal.com"), true);
	assert.equal(spam.isLookalikeDomain("rnicrosoft.com", "microsoft.com"), true);
	assert.equal(spam.isLookalikeDomain("northwind-email.com", "northwind.email"), false);
	assert.equal(spam.isLookalikeDomain("northwnd.email", "northwind.email"), true);
	assert.equal(spam.isLookalikeDomain("example.ch", "example.com"), false);
	assert.equal(spam.isLookalikeDomain("github.com", "gitlab.com"), false);

	const known = ["northwind.email", "gmail.com"];
	assert.deepEqual(ids(spam.analyzeImpersonation('"PayPal Service" <notice@secure-verify.top>', known)), ["brand_display_name"]);
	assert.deepEqual(ids(spam.analyzeImpersonation('"PayPal" <service@paypal.ch>', known)), []);
	assert.deepEqual(ids(spam.analyzeImpersonation('"Weekly Outlook" <news@markets.example>', known)), []);
	assert.deepEqual(ids(spam.analyzeImpersonation('"anna@northwind.email" <x@other.example>', known)), ["address_in_display_name"]);
	assert.deepEqual(ids(spam.analyzeImpersonation("Anna <anna@northwnd.email>", known)), ["lookalike_domain"]);
	assert.deepEqual(ids(spam.analyzeImpersonation("Anna <anna@northwind.email>", known)), []);
});

test("brands added by the administrator are checked alongside the built-in list", () => {
	const brands = [{ name: "PostFinance", domains: ["postfinance.ch"] }, { name: "Swiss Post", domains: ["post.ch", "swisspost.ch"] }];
	assert.deepEqual(ids(spam.analyzeImpersonation('"PostFinance Kundendienst" <info@pf-secure.top>', [], brands)), ["brand_display_name"]);
	assert.deepEqual(ids(spam.analyzeImpersonation('"PostFinance" <noreply@postfinance.ch>', [], brands)), []);
	assert.deepEqual(ids(spam.analyzeImpersonation('"SwissPost Paket" <x@parcel-track.top>', [], brands)), ["brand_display_name"]);
	assert.deepEqual(ids(spam.analyzeImpersonation('"Die Post" <news@post.ch>', [], brands)), []);
	assert.deepEqual(ids(spam.analyzeImpersonation('"PostFinance" <info@pf-secure.top>', [])), [], "regional brands are not built in");
	assert.deepEqual(ids(spam.analyzeImpersonation('"Postfinancer Club" <a@club.example>', [], brands)), [], "only whole words match");
});

test("the brand list round-trips through its one-brand-per-line text form", () => {
	const parsed = spam.parseBrandLines("PostFinance = postfinance.ch, @PostFinance.com\n\nSwisscom=swisscom.ch\nbroken line\nX = a.ch\nUBS = not a domain");
	assert.deepEqual(parsed.brands, [{ name: "PostFinance", domains: ["postfinance.ch", "postfinance.com"] }, { name: "Swisscom", domains: ["swisscom.ch"] }]);
	assert.deepEqual(parsed.invalidLines, [4, 5, 6]);
	assert.equal(spam.formatBrandLines(parsed.brands), "PostFinance = postfinance.ch, postfinance.com\nSwisscom = swisscom.ch");
});

test("before the settings migration runs, lookups fall back to environment variables", async () => {
	const DB = { prepare() { throw new Error("no such column: spamhaus_dqs_key"); } };
	const config = await spam.getSpamIntelligenceConfig({ DB, SPAMHAUS_DQS_KEY: " dqs-key ", SPAM_DOMAIN_AGE_CHECK: "off" });
	assert.deepEqual(config, { spamhausDqsKey: "dqs-key", abuseChAuthKey: undefined, domainAge: false, brands: [] });
});

function stubFetch(routes) {
	const calls = [];
	const fetcher = async (input, init) => {
		const url = String(input);
		calls.push(url);
		for (const [pattern, respond] of routes) if (url.includes(pattern)) return respond(url, init);
		throw new Error(`unexpected fetch ${url}`);
	};
	return { calls, fetcher };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const dns = (...addresses) => json({ Status: addresses.length ? 0 : 3, Answer: addresses.map((data) => ({ name: "x", type: 1, TTL: 60, data })) });

test("the external provider combines Spamhaus, URLhaus and RDAP and caches each answer", async () => {
	const registered = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
	const { calls, fetcher } = stubFetch([
		["9.113.0.203.KEY.zen", () => dns("127.0.0.4")],
		["spam-sender.example.KEY.dbl", () => dns()],
		["bad-link.example.KEY.dbl", () => dns("127.0.1.4")],
		["broken.example.KEY.dbl", () => dns("127.255.255.254")],
		["urlhaus-api.abuse.ch", (_url, init) => json(init.body.get("host") === "bad-link.example"
			? { query_status: "ok", urls: [{ url_status: "offline" }, { url_status: "online" }] }
			: { query_status: "no_results" })],
		["rdap.org/domain/spam-sender.example", () => json({ events: [{ eventAction: "registration", eventDate: registered }] })],
		["rdap.org/domain/", () => json({}, 404)],
	]);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetcher;
	try {
		const provider = new spam.ExternalSpamIntelligenceProvider({ spamhausDqsKey: "KEY", abuseChAuthKey: "AUTH", domainAge: true }, undefined, fetcher);
		const input = { senderDomain: "mail.spam-sender.example", urlDomains: ["bad-link.example", "www.broken.example", "not a host"], fingerprint: "f", senderIp: "203.0.113.9" };
		const signals = await provider.check(input);
		assert.deepEqual(ids(signals), ["new_sender_domain", "spamhaus_domain_phish", "spamhaus_ip_listed", "urlhaus_malware_host"]);
		const first = calls.length;
		await provider.check(input);
		assert.equal(calls.length, first, "second check is served from the cache");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("without keys only the domain age is checked, and failures add no signal", async () => {
	const { calls, fetcher } = stubFetch([["rdap.org", () => { throw new Error("network down"); }]]);
	const provider = new spam.ExternalSpamIntelligenceProvider({ domainAge: true }, undefined, fetcher);
	assert.deepEqual(await provider.check({ senderDomain: "offline.example", urlDomains: [], fingerprint: "f", senderIp: "203.0.113.10" }), []);
	assert.deepEqual(calls, ["https://rdap.org/domain/offline.example"]);
	const disabled = new spam.ExternalSpamIntelligenceProvider({ domainAge: false }, undefined, fetcher);
	assert.deepEqual(await disabled.check({ senderDomain: "other.example", urlDomains: ["a.example"], fingerprint: "f" }), []);
	assert.equal(calls.length, 1);
});

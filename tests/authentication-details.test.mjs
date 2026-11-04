import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-authentication-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: [
			`export { readSesAuthentication, readSesTrace } from "./src/lib/email/provider-trace";`,
			`export { getSenderWarning } from "./src/components/messages/message-details-utils";`,
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

const provider = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const encoder = new TextEncoder();
const raw = (text) => encoder.encode(text.replace(/\n/g, "\r\n")).buffer;

const sesHeaders = `Return-Path: <bounce@mail.example.com>
Received: from mail.example.com (mail.example.com [203.0.113.5]) by inbound-smtp.us-east-1.amazonaws.com with SMTP id abc (version=TLSv1.3, cipher=TLS_AES_256_GCM_SHA384) for <me@example.org>; Thu, 29 Oct 2026 06:54:00 +0000
Authentication-Results: amazonses.com; spf=pass (sender IP is 203.0.113.5) smtp.mailfrom=example.com; dkim=pass header.d=example.com header.i=@example.com; dmarc=pass header.from=example.com;
X-SES-Spam-Verdict: PASS
X-SES-Virus-Verdict: PASS
X-SES-Receipt: abc`;

test("trusted SES headers expose authentication results and connection metadata", () => {
	const authentication = provider.readSesAuthentication(raw(`${sesHeaders}
From: "Ashby Recruiting" <no-reply@example.com>
To: me@example.org
Subject: Hello

Body`), "no-reply@example.com");

	assert.ok(authentication);
	assert.deepEqual(authentication.spf, { status: "PASS", detail: "IP 203.0.113.5" });
	assert.deepEqual(authentication.dkim, { status: "PASS", detail: "d=example.com" });
	assert.deepEqual(authentication.dmarc, { status: "PASS", detail: "header.from=example.com" });
	assert.equal(authentication.signedBy, "example.com");
	assert.equal(authentication.mailedBy, "example.com");
	assert.equal(authentication.senderIp, "203.0.113.5");
	assert.equal(authentication.encryption, "TLS 1.3");
	assert.equal(authentication.aligned, true);
});

test("failed results are reported without pretending the sender is verified", () => {
	const authentication = provider.readSesAuthentication(raw(`Return-Path: <bounce@esp.example.net>
Authentication-Results: amazonses.com; spf=fail smtp.mailfrom=esp.example.net; dkim=fail header.d=esp.example.net; dmarc=fail header.from=example.com;
X-SES-Receipt: abc
From: Example <no-reply@example.com>

Body`), "no-reply@example.com");

	assert.ok(authentication);
	assert.equal(authentication.spf.status, "FAIL");
	assert.equal(authentication.dkim.status, "FAIL");
	assert.equal(authentication.dmarc.status, "FAIL");
	assert.equal(authentication.aligned, null);
});

test("a passing aligned signature wins over an earlier failing one", () => {
	const authentication = provider.readSesAuthentication(raw(`Authentication-Results: amazonses.com; spf=fail smtp.mailfrom=esp.example.net; dkim=fail header.d=esp.example.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com;
X-SES-Receipt: abc
From: Example <no-reply@example.com>

Body`), "no-reply@example.com");

	assert.ok(authentication);
	assert.equal(authentication.spf.status, "FAIL");
	assert.deepEqual(authentication.dkim, { status: "PASS", detail: "d=example.com" });
	assert.equal(authentication.signedBy, "example.com");
	assert.equal(authentication.aligned, true);
});

test("header.i identities are reduced to their signing domain", () => {
	const authentication = provider.readSesAuthentication(raw(`Authentication-Results: amazonses.com; dkim=pass header.i=sender@example.com; dmarc=pass header.from=example.com;
X-SES-Receipt: abc
From: Example <no-reply@example.com>

Body`), "no-reply@example.com");

	assert.ok(authentication);
	assert.equal(authentication.signedBy, "example.com");
	assert.deepEqual(authentication.dkim, { status: "PASS", detail: "d=example.com" });
	assert.equal(authentication.aligned, true);
});

test("unrelated registrations under a shared suffix are not treated as aligned", () => {
	const authentication = provider.readSesAuthentication(raw(`Authentication-Results: amazonses.com; dkim=pass header.d=attacker.co.ke; dmarc=fail header.from=victim.co.ke;
X-SES-Receipt: abc
From: Victim <no-reply@victim.co.ke>

Body`), "no-reply@victim.co.ke");

	assert.ok(authentication);
	assert.equal(authentication.signedBy, "attacker.co.ke");
	assert.equal(authentication.aligned, false);
});

test("messages without a trusted SES trace report no authentication", () => {
	const withoutReceipt = raw(`Authentication-Results: amazonses.com; spf=pass dkim=pass dmarc=pass
From: no-reply@example.com

Body`);
	assert.equal(provider.readSesAuthentication(withoutReceipt, "no-reply@example.com"), null);

	const forgedAfterOtherHeader = raw(`From: no-reply@example.com
Authentication-Results: amazonses.com; spf=pass dkim=pass dmarc=pass
X-SES-Receipt: abc

Body`);
	assert.equal(provider.readSesAuthentication(forgedAfterOtherHeader, "no-reply@example.com"), null);

	const otherProvider = raw(`Authentication-Results: mx.cloudflare.net; spf=pass dkim=pass dmarc=pass
X-SES-Receipt: abc
From: no-reply@example.com

Body`);
	assert.equal(provider.readSesAuthentication(otherProvider, "no-reply@example.com"), null);
});

test("the existing SES trace keeps the same verdicts and sender IP", () => {
	const trace = provider.readSesTrace(raw(`${sesHeaders}
From: no-reply@example.com

Body`));
	assert.deepEqual(trace.verdicts, { spf: "PASS", dkim: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" });
	assert.equal(trace.senderIp, "203.0.113.5");
});

test("DMARC-passing mail across sibling subdomains does not raise a sender warning", () => {
	const authentication = provider.readSesAuthentication(raw(`Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=bounce.mail.example.com; dkim=pass header.d=mail.example.com; dmarc=pass header.from=news.example.com;
X-SES-Receipt: abc
From: News <news@news.example.com>

Body`), "news@news.example.com");

	assert.ok(authentication);
	assert.equal(authentication.dmarc.status, "PASS");
	// The conservative signature matcher sees siblings as unrelated; DMARC proves alignment.
	assert.equal(authentication.aligned, false);
	assert.equal(
		provider.getSenderWarning(
			{ direction: "inbound", fromAddr: "News <news@news.example.com>", replyTo: null },
			{ available: true, ...authentication },
		),
		null,
	);
});

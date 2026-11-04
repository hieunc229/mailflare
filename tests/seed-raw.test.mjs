import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-seed-raw-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: [
			`export { buildSeedRawMessage } from "./src/lib/seed-raw";`,
			`export { readSesAuthentication } from "./src/lib/email/provider-trace";`,
			`export { getSenderWarning } from "./src/components/messages/message-details-utils";`,
			`export { seedMessages } from "./src/lib/seed-utils";`,
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

const seed = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const createdAt = new Date("2026-10-29T10:00:00Z");
const encoder = new TextEncoder();

function message(overrides = {}) {
	return {
		mailbox: "support",
		direction: "inbound",
		status: "received",
		fromAddr: `"Lumen Recruiting" <no-reply@lumenhq.test>`,
		toAddr: `"Support" <support@example.com>`,
		ccAddr: `"Maya Chen" <maya@acme.test>`,
		bccAddr: `"Archive" <archive@example.com>`,
		replyTo: `"Lumen Talent" <reply@lumenhq.test>`,
		subject: "Application received: Maya Chen",
		textBody: "The hiring team will follow up with next steps.",
		read: false,
		minutesAgo: 11,
		providerMessageId: "<seed-lumen-received@example.test>",
		threadId: "<seed-thread-lumen@example.test>",
		inReplyTo: "<seed-lumen-parent@example.test>",
		references: "<seed-lumen-parent@example.test>",
		raw: {
			trusted: true,
			signedBy: "lumenhq.test",
			mailedBy: "lumenhq.test",
			senderIp: "203.0.113.24",
		},
		...overrides,
	};
}

function rawBytes(seedMessage) {
	return encoder.encode(seed.buildSeedRawMessage(seedMessage, createdAt)).buffer;
}

// Mirrors the API shape: trusted results are wrapped in `available`.
function asApiAuthentication(authentication) {
	return authentication ? { available: true, ...authentication } : { available: false, reason: "untrusted" };
}

test("a trusted seed message produces readable message headers and authentication", () => {
	const source = seed.buildSeedRawMessage(message(), createdAt);
	assert.match(source, /^Return-Path: <bounce@lumenhq\.test>/);
	assert.match(source, /\r\nCc: "Maya Chen" <maya@acme\.test>/);
	assert.match(source, /\r\nBcc: "Archive" <archive@example\.com>/);
	assert.match(source, /\r\nReply-To: "Lumen Talent" <reply@lumenhq\.test>/);
	assert.match(source, /\r\nIn-Reply-To: <seed-lumen-parent@example\.test>/);
	assert.match(source, /\r\nMessage-ID: <seed-lumen-received@example\.test>/);

	const authentication = seed.readSesAuthentication(rawBytes(message()), "no-reply@lumenhq.test");
	assert.ok(authentication);
	assert.equal(authentication.spf.status, "PASS");
	assert.equal(authentication.dkim.status, "PASS");
	assert.equal(authentication.dmarc.status, "PASS");
	assert.equal(authentication.signedBy, "lumenhq.test");
	assert.equal(authentication.mailedBy, "lumenhq.test");
	assert.equal(authentication.senderIp, "203.0.113.24");
	assert.equal(authentication.encryption, "TLS 1.3");
	assert.equal(authentication.aligned, true);
});

test("a failing seed message reflects the failure in the details panel", () => {
	const authentication = seed.readSesAuthentication(rawBytes(message({
		fromAddr: `"security@cobaltbank.test" <alerts@cobalt-secure.test>`,
		raw: {
			trusted: true,
			spf: "fail",
			dkim: "fail",
			dmarc: "fail",
			signedBy: "cobalt-secure.test",
			mailedBy: "cobalt-secure.test",
			senderIp: "198.51.100.42",
			tls: "TLSv1.2",
		},
	})), "alerts@cobalt-secure.test");

	assert.ok(authentication);
	assert.equal(authentication.spf.status, "FAIL");
	assert.equal(authentication.dkim.status, "FAIL");
	assert.equal(authentication.dmarc.status, "FAIL");
	assert.equal(authentication.encryption, "TLS 1.2");
	assert.equal(authentication.aligned, null);
});

test("the seeded sender-details demo set has the intended shape", () => {
	const byProviderId = new Map(seed.seedMessages.map((message) => [message.providerMessageId, message]));
	const received = byProviderId.get("<seed-lumen-received@example.test>");
	const scheduled = byProviderId.get("<seed-lumen-scheduled@example.test>");
	assert.ok(received && scheduled);

	assert.equal(received.threadId, scheduled.threadId);
	assert.notEqual(received.fromAddr, scheduled.fromAddr);
	assert.equal(received.fromAddr.match(/<([^>]+)>/)?.[1], scheduled.fromAddr.match(/<([^>]+)>/)?.[1]);
	assert.equal(scheduled.inReplyTo, received.providerMessageId);
	assert.equal(received.replyTo, scheduled.replyTo);

	const receivedAuth = asApiAuthentication(seed.readSesAuthentication(rawBytes(received), "no-reply@lumenhq.test"));
	const scheduledAuth = asApiAuthentication(seed.readSesAuthentication(rawBytes(scheduled), "no-reply@lumenhq.test"));
	assert.equal(receivedAuth?.dmarc?.status, "PASS");
	assert.equal(scheduledAuth?.dkim?.status, "PASS");
	assert.equal(seed.getSenderWarning(received, receivedAuth), null);
	assert.equal(seed.getSenderWarning(scheduled, scheduledAuth), null);

	const cobalt = byProviderId.get("<seed-cobalt-invoice@example.test>");
	assert.ok(cobalt);
	assert.ok(cobalt.ccAddr?.includes("Northwind AP"));
	assert.ok(cobalt.bccAddr?.includes("Archive"));
	assert.match(cobalt.replyTo ?? "", /<accounts@cobalt\.test>$/);
	assert.equal(seed.getSenderWarning(cobalt, asApiAuthentication(seed.readSesAuthentication(rawBytes(cobalt), "finance@cobalt.test"))), null);

	const meridian = byProviderId.get("<seed-meridian-payment@example.test>");
	assert.ok(meridian);
	assert.match(meridian.replyTo ?? "", /@meridian-payments\.test/);
	assert.deepEqual(
		seed.getSenderWarning(meridian, asApiAuthentication(seed.readSesAuthentication(rawBytes(meridian), "billing@meridian.test"))),
		{ level: "warning", reasons: ["replyTo"] },
	);

	const impersonation = byProviderId.get("<seed-cobalt-signin@example.test>");
	assert.ok(impersonation);
	assert.match(impersonation.fromAddr, /^"security@cobaltbank\.test"/);
	const impersonationAuth = asApiAuthentication(seed.readSesAuthentication(rawBytes(impersonation), "alerts@cobalt-secure.test"));
	assert.equal(impersonationAuth?.dmarc?.status, "FAIL");
	assert.deepEqual(
		seed.getSenderWarning(impersonation, impersonationAuth),
		{ level: "warning", reasons: ["authentication", "senderName", "replyTo"] },
	);

	const vendor = byProviderId.get("<seed-vendor-terms@example.test>");
	assert.ok(vendor);
	assert.equal(vendor.raw?.trusted, false);
	const vendorAuth = asApiAuthentication(seed.readSesAuthentication(rawBytes(vendor), "notice@vendor.test"));
	assert.equal(vendorAuth.available, false);
	assert.equal(seed.getSenderWarning(vendor, vendorAuth), null);
});

test("an untrusted seed message keeps forged authentication unavailable", () => {
	const untrusted = message({
		fromAddr: `"Vendor Notice" <notice@vendor.test>`,
		replyTo: null,
		ccAddr: null,
		bccAddr: null,
		raw: { trusted: false },
	});
	const source = seed.buildSeedRawMessage(untrusted, createdAt);
	assert.match(source, /^Authentication-Results: amazonses\.com;/);
	assert.equal(seed.readSesAuthentication(rawBytes(untrusted), "notice@vendor.test"), null);
});

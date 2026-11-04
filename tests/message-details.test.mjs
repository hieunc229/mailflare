import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-message-details-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: [
			`export { getOriginalSender, getReplyToEntries, getSenderWarning, hasFailingAuthenticationCheck, hasPassingAuthenticationCheck, hasSenderNameAddressMismatch, isReplyToDifferent } from "./src/components/messages/message-details-utils";`,
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
	alias: { "@": join(root, "src") },
});

const details = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("the original sender keeps the name and address from the message header", () => {
	assert.deepEqual(details.getOriginalSender('"Ashby Recruiting" <no-reply@ashbyhq.com>'), {
		name: "Ashby Recruiting",
		address: "no-reply@ashbyhq.com",
		label: "Ashby Recruiting <no-reply@ashbyhq.com>",
	});
	assert.deepEqual(details.getOriginalSender("no-reply@ashbyhq.com"), {
		name: null,
		address: "no-reply@ashbyhq.com",
		label: "no-reply@ashbyhq.com",
	});
});

test("a Reply-To on another domain is called out", () => {
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@example.com>", replyTo: "help@example.com" }), false);
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@example.com>", replyTo: "HELP@example.com" }), false);
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@example.com>", replyTo: "billing@example.com" }), false);
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@example.com>", replyTo: "billing@mail.example.com" }), false);
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@example.com>", replyTo: "billing@example.net" }), true);
	// Two registrations under a shared two-label suffix are different owners.
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@victim.co.ke>", replyTo: "billing@attacker.co.ke" }), true);
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@example.com>", replyTo: null }), false);
	assert.equal(details.isReplyToDifferent({ fromAddr: "Support <help@example.com>", replyTo: "" }), false);
});

test("a display name carrying another email address raises a warning", () => {
	assert.equal(details.hasSenderNameAddressMismatch({ fromAddr: '"support@paypal.com" <attacker@example.net>' }), true);
	assert.equal(details.hasSenderNameAddressMismatch({ fromAddr: '"PayPal support@paypal.com" <help@paypal.com>' }), true);
	assert.equal(details.hasSenderNameAddressMismatch({ fromAddr: '"PayPal Support" <support@paypal.com>' }), false);
	assert.equal(details.hasSenderNameAddressMismatch({ fromAddr: "support@paypal.com" }), false);
});

test("Reply-To entries keep display names intact", () => {
	assert.deepEqual(
		details.getReplyToEntries('"Replies, Inc." <replies@example.com>, other@example.net'),
		['"Replies, Inc." <replies@example.com>', "other@example.net"],
	);
});

function authentication(overrides = {}) {
	return {
		available: true,
		spf: { status: "PASS", detail: null },
		dkim: { status: "PASS", detail: null },
		dmarc: { status: "PASS", detail: null },
		signedBy: "example.com",
		mailedBy: "example.com",
		senderIp: null,
		encryption: null,
		aligned: true,
		...overrides,
	};
}

function message(overrides = {}) {
	return {
		direction: "inbound",
		fromAddr: "Support <help@example.com>",
		replyTo: null,
		...overrides,
	};
}

test("a clean message needs no surface warning", () => {
	assert.equal(details.getSenderWarning(message(), authentication()), null);
	assert.equal(details.getSenderWarning(message(), { available: false, reason: "untrusted" }), null);
	// Outbound mail is not an inbound impersonation warning.
	assert.equal(details.getSenderWarning(message({
		direction: "outbound",
		fromAddr: '"help@example.com" <support@example.com>',
	}), authentication()), null);
});

test("a failed sender authentication is surfaced without opening details", () => {
	assert.deepEqual(
		details.getSenderWarning(message(), authentication({ dmarc: { status: "FAIL", detail: null } })),
		{ level: "warning", reasons: ["authentication"] },
	);
	assert.deepEqual(
		details.getSenderWarning(message(), authentication({
			dmarc: null,
			spf: { status: "FAIL", detail: null },
			dkim: { status: "FAIL", detail: null },
		})),
		{ level: "warning", reasons: ["authentication"] },
	);
});

test("a passing DMARC result is not overruled by a forwarded SPF failure", () => {
	assert.equal(
		details.getSenderWarning(message(), authentication({ spf: { status: "FAIL", detail: null } })),
		null,
	);
	assert.equal(
		details.getSenderWarning(message(), authentication({
			dmarc: null,
			spf: { status: "FAIL", detail: null },
			dkim: { status: "PASS", detail: null },
		})),
		null,
	);
});

test("sender-name and cross-domain Reply-To warnings survive a passing authentication", () => {
	assert.deepEqual(
		details.getSenderWarning(message({
			fromAddr: '"security@paypal.com" <alerts@paypal-secure.test>',
			replyTo: '"Help" <help@paypal-help.test>',
		}), authentication()),
		{ level: "warning", reasons: ["senderName", "replyTo"] },
	);
});

test("an unaligned signature is called out only when DMARC has not passed", () => {
	assert.equal(details.getSenderWarning(message(), authentication({ aligned: false })), null);
	assert.deepEqual(
		details.getSenderWarning(message(), authentication({
			aligned: false,
			dmarc: null,
			dkim: { status: "PASS", detail: null },
			spf: { status: "PASS", detail: null },
		})),
		{ level: "warning", reasons: ["domain"] },
	);
	assert.deepEqual(
		details.getSenderWarning(message(), authentication({
			aligned: false,
			dmarc: { status: "FAIL", detail: null },
		})),
		{ level: "warning", reasons: ["authentication"] },
	);
});

test("authentication notes depend on which checks passed or failed", () => {
	assert.equal(details.hasPassingAuthenticationCheck(authentication()), true);
	assert.equal(details.hasFailingAuthenticationCheck(authentication()), false);

	const failed = authentication({
		spf: { status: "FAIL", detail: null },
		dkim: { status: "FAIL", detail: null },
		dmarc: { status: "FAIL", detail: null },
	});
	assert.equal(details.hasPassingAuthenticationCheck(failed), false);
	assert.equal(details.hasFailingAuthenticationCheck(failed), true);

	const mixed = authentication({ spf: { status: "FAIL", detail: null } });
	assert.equal(details.hasPassingAuthenticationCheck(mixed), true);
	assert.equal(details.hasFailingAuthenticationCheck(mixed), true);

	assert.equal(details.hasPassingAuthenticationCheck({ available: false, reason: "untrusted" }), false);
	assert.equal(details.hasFailingAuthenticationCheck({ available: false, reason: "untrusted" }), false);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-dsn-precheck-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/deliverability/dsn.ts")],
	outfile: join(directory, "dsn.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { parseDeliveryStatus } = await import(pathToFileURL(join(directory, "dsn.mjs")).href);
const bytes = (text) => new TextEncoder().encode(text).buffer;

// Records how many bytes each decode call is given.
function spyOnDecoder(t) {
	const sizes = [];
	const original = TextDecoder.prototype.decode;
	t.mock.method(TextDecoder.prototype, "decode", function (input, ...rest) {
		sizes.push(input?.byteLength ?? 0);
		return original.call(this, input, ...rest);
	});
	return sizes;
}

test("a large ordinary message is rejected after reading only its headers", (t) => {
	const sizes = spyOnDecoder(t);
	const raw = bytes(`From: a@x.test\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(300 * 1024)}`);
	assert.equal(parseDeliveryStatus(raw), null);
	assert.ok(Math.max(...sizes) <= 8 * 1024, `decoded ${Math.max(...sizes)} bytes`);
});

test("a delivery status report still parses", () => {
	const dsn = [
		"From: mailer-daemon@x.test",
		'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
		"",
		"--b1",
		"Content-Type: text/plain",
		"",
		"Delivery failed",
		"--b1",
		"Content-Type: message/delivery-status",
		"",
		"Final-Recipient: rfc822; gone@example.org",
		"Action: failed",
		"Status: 5.1.1",
		"",
		"--b1--",
		"",
	].join("\r\n");
	const parsed = parseDeliveryStatus(bytes(dsn));
	assert.equal(parsed?.recipients[0]?.finalRecipient, "gone@example.org");
	assert.equal(parsed?.recipients[0]?.status, "5.1.1");
});

test("a report whose headers are longer than the precheck window still parses", () => {
	const padding = `X-Pad: ${"p".repeat(10 * 1024)}\r\n`;
	const dsn = `From: mailer-daemon@x.test\r\n${padding}Content-Type: multipart/report; report-type=delivery-status; boundary="b1"\r\n\r\n--b1\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; gone@example.org\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--b1--\r\n`;
	assert.equal(parseDeliveryStatus(bytes(dsn))?.recipients[0]?.finalRecipient, "gone@example.org");
});

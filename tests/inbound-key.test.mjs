import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const outDir = mkdtempSync(join(tmpdir(), "mailflare-inbound-key-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { extractMessageIdHeader, inboundMessageId, inboundStorageKey } from "./src/lib/email/inbound-id.ts";`,
		resolveDir: root,
		sourcefile: "inbound-key-test-entry.js",
	},
	outfile: join(outDir, "inbound-key.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { extractMessageIdHeader, inboundMessageId, inboundStorageKey } = await import(pathToFileURL(join(outDir, "inbound-key.mjs")).href);

function raw(headers) {
	return new TextEncoder().encode(`${headers}\r\n\r\nBody.\r\n`).buffer;
}

test("extractMessageIdHeader reads a case-insensitive Message-ID", () => {
	assert.equal(extractMessageIdHeader(raw("From: a@b\r\nmessage-id: <relay-1@example.com>\r\nSubject: hi")), "<relay-1@example.com>");
});

test("extractMessageIdHeader unfolds a folded Message-ID", () => {
	assert.equal(extractMessageIdHeader(raw("Message-ID: <abc\r\n @example.com>")), "<abc @example.com>");
});

test("extractMessageIdHeader returns null when absent", () => {
	assert.equal(extractMessageIdHeader(raw("From: a@b\r\nSubject: hi")), null);
});

test("inboundStorageKey is stable for the same mailbox and Message-ID", async () => {
	const a = await inboundStorageKey(raw("Message-ID: <x@y>"), "mb1");
	const b = await inboundStorageKey(raw("Message-ID: <x@y>"), "mb1");
	assert.equal(a, b);
	assert.match(a, /^inbound\/[0-9a-f]{64}\.eml$/);
});

test("inboundStorageKey differs per mailbox for the same Message-ID", async () => {
	const a = await inboundStorageKey(raw("Message-ID: <x@y>"), "mb1");
	const b = await inboundStorageKey(raw("Message-ID: <x@y>"), "mb2");
	assert.notEqual(a, b);
});

test("inboundStorageKey differs for different Message-IDs", async () => {
	const a = await inboundStorageKey(raw("Message-ID: <x@y>"), "mb1");
	const b = await inboundStorageKey(raw("Message-ID: <z@y>"), "mb1");
	assert.notEqual(a, b);
});

test("inboundStorageKey falls back to a content hash when Message-ID is absent", async () => {
	const a = await inboundStorageKey(raw("From: a@b\r\nSubject: hi"), "mb1");
	const b = await inboundStorageKey(raw("From: a@b\r\nSubject: hi"), "mb1");
	assert.equal(a, b);
	const c = await inboundStorageKey(raw("From: a@b\r\nSubject: bye"), "mb1");
	assert.notEqual(a, c);
});

test("inboundMessageId still derives a stable id from the key", async () => {
	const key = await inboundStorageKey(raw("Message-ID: <x@y>"), "mb1");
	assert.equal(await inboundMessageId(key), await inboundMessageId(key));
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-address-quoting-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/email/address.ts")],
	outfile: join(outDir, "address.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const address = await import(pathToFileURL(join(outDir, "address.mjs")).href);

test("a display name with quotes survives formatEmailAddress and parseEmailAddressParts", () => {
	const formatted = address.formatEmailAddress("maya@example.com", 'Maya "MJ" Chen');
	assert.equal(formatted, '"Maya \\"MJ\\" Chen" <maya@example.com>');
	assert.deepEqual(address.parseEmailAddressParts(formatted), { name: 'Maya "MJ" Chen', address: "maya@example.com" });
	assert.equal(address.getEmailAddress(formatted), "maya@example.com");
	assert.equal(address.normalizeEmailAddress(formatted), "maya@example.com");
	assert.equal(address.getEmailDisplayName(formatted), 'Maya "MJ" Chen');
});

test("a backslash in a display name is unescaped once", () => {
	const formatted = address.formatEmailAddress("ops@example.com", "Ops\\EU");
	assert.equal(formatted, '"Ops\\\\EU" <ops@example.com>');
	assert.deepEqual(address.parseEmailAddressParts(formatted), { name: "Ops\\EU", address: "ops@example.com" });
});

test("an escaped quote does not end the quoted name when splitting a list", () => {
	assert.deepEqual(address.splitEmailAddressList('"5\\" Screens, Inc" <sales@example.com>, bob@example.com'), [
		'"5\\" Screens, Inc" <sales@example.com>',
		"bob@example.com",
	]);
	assert.deepEqual(
		address.getEmailAddressList('"Maya \\"MJ\\" Chen" <Maya@Example.com>, "5\\" Screens, Inc" <sales@example.com>'),
		["maya@example.com", "sales@example.com"],
	);
});

test("plain and unquoted names still parse as before", () => {
	assert.deepEqual(address.parseEmailAddressParts('"Chen, Maya" <maya@example.com>'), { name: "Chen, Maya", address: "maya@example.com" });
	assert.deepEqual(address.parseEmailAddressParts("Ada <ada@example.com>"), { name: "Ada", address: "ada@example.com" });
	assert.deepEqual(address.parseEmailAddressParts("ada@example.com"), { name: null, address: "ada@example.com" });
	assert.deepEqual(address.splitEmailAddressList('"Chen, Maya" <maya@example.com>; bob@example.com'), [
		'"Chen, Maya" <maya@example.com>',
		"bob@example.com",
	]);
});

test("an empty quoted display name leaves just the address", () => {
	assert.deepEqual(address.parseEmailAddressParts('"" <ada@example.com>'), { name: null, address: "ada@example.com" });
});

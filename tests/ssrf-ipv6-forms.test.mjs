import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-ssrf-ipv6-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/remote-images/fetch.ts")],
	outfile: join(outDir, "fetch.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { isPublicAddress } = await import(pathToFileURL(join(outDir, "fetch.mjs")).href);

test("private and reserved IPv6 spellings are not public", () => {
	for (const address of [
		"::", "::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001",
		"::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:7F00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:a00:1", "::ffff:c0a8:101", "::ffff:ac10:1",
		"::7f00:1", "::a00:1", "::127.0.0.1",
		"64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "64:ff9b:1::1",
		"2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101::",
		"fc00::1", "fd00::1", "fe80::1", "fe80::1%eth0", "fec0::1", "feff::1", "ff02::1",
		"::ffff:0:0:1", "not-an-ip", "1:2:3:4:5:6:7:8:9", "1::2::3",
	]) {
		assert.equal(isPublicAddress(address), false, address);
	}
});

test("public addresses are still public in every spelling", () => {
	for (const address of [
		"93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860:0:0:0:0:8888", "2a00:1450:4001:81b::200e",
		"::ffff:5db8:d822", "::ffff:93.184.216.34", "64:ff9b::5db8:d822", "2002:5db8:d822::1",
	]) {
		assert.equal(isPublicAddress(address), true, address);
	}
});

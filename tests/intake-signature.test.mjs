import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-intake-sig-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/email/intake-signature.ts")], outfile: join(dir, "sig.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const sig = await import(pathToFileURL(join(dir, "sig.mjs")).href);

const raw = new TextEncoder().encode("Subject: hi\r\n\r\nbody").buffer;
const headers = JSON.stringify({ subject: "hi", "list-id": "x" });
const now = 1_900_000_000;

test("v2 signature binds headers and timestamp", async () => {
	const signature = await sig.signInboundV2("s3cret", raw, "a@x.test", "b@y.test", headers, String(now));
	assert.equal(await sig.verifyInboundSignatureV2("s3cret", signature, raw, "a@x.test", "b@y.test", headers, String(now), now), true);
	const tampered = JSON.stringify({ subject: "hi", "list-id": "x", "auto-submitted": "no" });
	assert.equal(await sig.verifyInboundSignatureV2("s3cret", signature, raw, "a@x.test", "b@y.test", tampered, String(now), now), false);
	assert.equal(await sig.verifyInboundSignatureV2("s3cret", signature, raw, "a@x.test", "c@y.test", headers, String(now), now), false);
	assert.equal(await sig.verifyInboundSignatureV2("other", signature, raw, "a@x.test", "b@y.test", headers, String(now), now), false);
});

test("v2 signatures expire", async () => {
	const signature = await sig.signInboundV2("s3cret", raw, "a@x.test", "b@y.test", headers, String(now));
	assert.equal(await sig.verifyInboundSignatureV2("s3cret", signature, raw, "a@x.test", "b@y.test", headers, String(now), now + 299), true);
	assert.equal(await sig.verifyInboundSignatureV2("s3cret", signature, raw, "a@x.test", "b@y.test", headers, String(now), now + 301), false);
	assert.equal(await sig.verifyInboundSignatureV2("s3cret", signature, raw, "a@x.test", "b@y.test", headers, "not-a-number", now), false);
});

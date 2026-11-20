import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-trusted-dmarc-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ stdin: { contents: `export { readTrustedDmarcResult } from "./src/lib/spam/analyzers/authentication";`, resolveDir: root, loader: "ts" }, outfile: join(outDir, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
const { readTrustedDmarcResult } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("only Cloudflare's authserv-id counts, and a failure anywhere wins", () => {
	assert.equal(readTrustedDmarcResult({ "authentication-results": "mx.cloudflare.net; spf=pass dkim=pass dmarc=pass" }), "pass");
	assert.equal(readTrustedDmarcResult({ "authentication-results": "attacker.example; dmarc=pass" }), undefined);
	assert.equal(readTrustedDmarcResult({ "authentication-results": "attacker.example; dmarc=pass, mx.cloudflare.net; dmarc=fail" }), "fail");
	assert.equal(readTrustedDmarcResult({ "authentication-results": "mx.cloudflare.net; dmarc=pass, mx.cloudflare.net; dmarc=fail" }), "fail");
	assert.equal(readTrustedDmarcResult({ "authentication-results": "mx.cloudflare.net; spf=pass" }), undefined);
	assert.equal(readTrustedDmarcResult({}), undefined);
	assert.equal(readTrustedDmarcResult(undefined, undefined), undefined);
});

test("provider verdicts outrank the header, as for spam analysis", () => {
	const forged = { "authentication-results": "mx.cloudflare.net; dmarc=pass" };
	assert.equal(readTrustedDmarcResult(forged, { dmarc: "FAIL" }), "fail");
	assert.equal(readTrustedDmarcResult(forged, { dmarc: "PASS" }), "pass");
	assert.equal(readTrustedDmarcResult(forged, { spf: "PASS" }), undefined, "verdicts present but no DMARC verdict: the header is not consulted");
	assert.equal(readTrustedDmarcResult(forged, { dmarc: "GRAY" }), undefined);
});

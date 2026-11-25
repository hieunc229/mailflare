import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mta-sts-ui-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: { utils: join(root, "src/app/(admin)/deliverability/mta-sts-utils.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { policyMatches, tlsErrorKey, mtaStsErrorKey, MAX_AGE_OPTIONS, retiringDays, policyKey, mxDiffers } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

const POLICY = "version: STSv1\r\nmode: testing\r\nmx: mx.example.net\r\nmax_age: 604800\r\n";

test("the fetched policy matches when every line is the same, whatever the line endings or trailing blank lines", () => {
	assert.equal(policyMatches(POLICY, POLICY), true);
	assert.equal(policyMatches(POLICY, POLICY.replaceAll("\r\n", "\n")), true);
	assert.equal(policyMatches(POLICY, `${POLICY}\r\n\r\n`), true);
	assert.equal(policyMatches(POLICY, POLICY.replace("testing", "enforce")), false);
	assert.equal(policyMatches(POLICY, POLICY.replace("mx.example.net", "evil.example.net")), false);
	assert.equal(policyMatches(POLICY, "<html>login</html>"), false);
	assert.equal(policyMatches(POLICY, ""), false);
	assert.equal(policyMatches(POLICY, `${POLICY}mx: extra.example.net\r\n`), false);
});

test("error codes map to the keys of their own tab, and unknown ones to null", () => {
	assert.equal(tlsErrorKey("REPORTS_REQUIRED"), "tls.error.REPORTS_REQUIRED");
	assert.equal(tlsErrorKey("DNS_FAILED"), "tls.error.DNS_FAILED");
	assert.equal(tlsErrorKey("NO_MX"), null);
	assert.equal(mtaStsErrorKey("NO_MX"), "mtasts.error.NO_MX");
	assert.equal(mtaStsErrorKey("ACKNOWLEDGE_REQUIRED"), "mtasts.error.ACKNOWLEDGE_REQUIRED");
	assert.equal(mtaStsErrorKey("MIGRATION_REQUIRED"), "mtasts.error.MIGRATION_REQUIRED");
	assert.equal(mtaStsErrorKey("REPORTS_REQUIRED"), null);
	assert.equal(mtaStsErrorKey(undefined), null);
});

test("cache time options are exactly the values the server accepts, and the removal period is shown in whole days", () => {
	assert.deepEqual(MAX_AGE_OPTIONS, [86400, 604800, 2592000, 31557600]);
	assert.equal(retiringDays(604800), 7);
	assert.equal(retiringDays(86400), 1);
	assert.equal(retiringDays(90000), 2, "rounded up");
	assert.equal(policyKey("sts"), "tls.policy.sts");
	assert.equal(policyKey("tlsa"), "tls.policy.tlsa");
	assert.equal(policyKey("no-policy-found"), "tls.policy.no-policy-found");
	assert.equal(policyKey("weird"), null);
});

test("the new refusal codes have strings, and the MX warning shows only for a published policy whose MX differs", () => {
	assert.equal(mtaStsErrorKey("INVALID_MX"), "mtasts.error.INVALID_MX");
	assert.equal(mtaStsErrorKey("MX_CHANGED_IN_ENFORCE"), "mtasts.error.MX_CHANGED_IN_ENFORCE");
	const differs = { status: "enforce", mxDrift: { liveMx: ["new.example.net"], differs: true } };
	assert.equal(mxDiffers(differs), true);
	assert.equal(mxDiffers({ ...differs, status: "testing" }), true);
	assert.equal(mxDiffers({ ...differs, status: "off" }), false);
	assert.equal(mxDiffers({ ...differs, mxDrift: { liveMx: [], differs: false } }), false);
	assert.equal(mxDiffers({ ...differs, mxDrift: { error: true } }), false, "an unreadable lookup shows nothing rather than a false alarm");
	assert.equal(mxDiffers({ ...differs, mxDrift: null }), false);
});

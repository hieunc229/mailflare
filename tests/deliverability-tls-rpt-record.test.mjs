import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-tls-record-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: { record: join(root, "src/lib/deliverability/dmarc-record.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const record = await import(pathToFileURL(join(outDir, "record.mjs")).href);
const { withTlsRuaUri, withoutTlsRuaUri, hasTlsRuaUri, withRuaUri } = record;

const ADDRESS = "mailflare-reports@example.com";
const URI = `mailto:${ADDRESS}`;

test("adds rua to a TLSRPTv1 record, appends to an existing one and keeps what was there", () => {
	assert.equal(withTlsRuaUri("v=TLSRPTv1", ADDRESS), `v=TLSRPTv1; rua=${URI}`);
	assert.equal(withTlsRuaUri("v=TLSRPTv1;", ADDRESS), `v=TLSRPTv1; rua=${URI}`);
	assert.equal(withTlsRuaUri("v=TLSRPTv1; rua=https://reports.vendor.example/tls", ADDRESS), `v=TLSRPTv1; rua=https://reports.vendor.example/tls,${URI}`);
	assert.equal(withTlsRuaUri("v=TLSRPTv1; rua=mailto:a@x.org , mailto:b@x.org ;", ADDRESS), `v=TLSRPTv1; rua=mailto:a@x.org , mailto:b@x.org,${URI} ;`);
});

test("adding is idempotent and case-insensitive on the address", () => {
	const once = withTlsRuaUri("v=TLSRPTv1", ADDRESS);
	assert.equal(withTlsRuaUri(once, ADDRESS), once);
	assert.equal(withTlsRuaUri(`v=TLSRPTv1; rua=mailto:${ADDRESS.toUpperCase()}`, ADDRESS), `v=TLSRPTv1; rua=mailto:${ADDRESS.toUpperCase()}`);
	assert.equal(hasTlsRuaUri(once, ADDRESS), true);
	assert.equal(hasTlsRuaUri("v=TLSRPTv1; rua=mailto:other@x.org", ADDRESS), false);
});

test("removing takes out only our address and keeps every other destination", () => {
	assert.equal(withoutTlsRuaUri(`v=TLSRPTv1; rua=https://v.example/tls,${URI}`, ADDRESS), "v=TLSRPTv1; rua=https://v.example/tls");
	assert.equal(withoutTlsRuaUri(`v=TLSRPTv1; rua=${URI},mailto:b@x.org`, ADDRESS), "v=TLSRPTv1; rua=mailto:b@x.org");
	assert.equal(withoutTlsRuaUri("v=TLSRPTv1; rua=mailto:b@x.org", ADDRESS), "v=TLSRPTv1; rua=mailto:b@x.org");
});

test("removing the only destination leaves a bare version tag, which the caller treats as 'delete the record'", () => {
	assert.equal(withoutTlsRuaUri(`v=TLSRPTv1; rua=${URI}`, ADDRESS), "v=TLSRPTv1");
});

test("a DMARC record is not a TLS-RPT record and the other way round", () => {
	assert.throws(() => withTlsRuaUri("v=DMARC1; p=none", ADDRESS), /not a TLS-RPT record/i);
	assert.throws(() => withoutTlsRuaUri("v=spf1 -all", ADDRESS), /not a TLS-RPT record/i);
	assert.throws(() => withRuaUri("v=TLSRPTv1", ADDRESS), /not a DMARC record/i);
	for (const bad of ["a@b.com; x=1", "a@b.com,mailto:evil@x.org", "a b@c.com", ""]) assert.throws(() => withTlsRuaUri("v=TLSRPTv1", bad), /address/i, bad);
});

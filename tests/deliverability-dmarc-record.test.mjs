import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dmarc-record-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: { record: join(root, "src/lib/deliverability/dmarc-record.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { withRuaUri, withoutRuaUri, hasRuaUri } = await import(pathToFileURL(join(outDir, "record.mjs")).href);

const ADDRESS = "mailflare-reports@example.com";
const URI = `mailto:${ADDRESS}`;

test("adds rua when the record has none, keeping the other tags byte for byte", () => {
	assert.equal(withRuaUri("v=DMARC1; p=none", ADDRESS), `v=DMARC1; p=none; rua=${URI}`);
	assert.equal(withRuaUri("v=DMARC1;p=reject;pct=50;  adkim=s", ADDRESS), `v=DMARC1;p=reject;pct=50;  adkim=s; rua=${URI}`);
});

test("a trailing semicolon is respected", () => {
	assert.equal(withRuaUri("v=DMARC1; p=none;", ADDRESS), `v=DMARC1; p=none; rua=${URI}`);
	assert.equal(withRuaUri("v=DMARC1; p=none;  ", ADDRESS), `v=DMARC1; p=none; rua=${URI}`);
});

test("appends to an existing rua without touching the existing destinations", () => {
	assert.equal(withRuaUri("v=DMARC1; p=none; rua=mailto:dmarc@vendor.example", ADDRESS), `v=DMARC1; p=none; rua=mailto:dmarc@vendor.example,${URI}`);
	assert.equal(withRuaUri("v=DMARC1; rua=mailto:a@x.org!10m, mailto:b@x.org ; p=none", ADDRESS), `v=DMARC1; rua=mailto:a@x.org!10m, mailto:b@x.org,${URI} ; p=none`);
});

test("is idempotent, including a different case and a size suffix", () => {
	const once = withRuaUri("v=DMARC1; p=none", ADDRESS);
	assert.equal(withRuaUri(once, ADDRESS), once);
	assert.equal(withRuaUri(`v=DMARC1; p=none; RUA=MAILTO:MailFlare-Reports@Example.com!5m`, ADDRESS), `v=DMARC1; p=none; RUA=MAILTO:MailFlare-Reports@Example.com!5m`);
});

test("preserves unknown tags and the order of tags", () => {
	const record = "v=DMARC1; p=quarantine; fo=1; x-custom=a b; ruf=mailto:f@x.org; sp=none";
	const added = withRuaUri(record, ADDRESS);
	assert.ok(added.startsWith(record));
	assert.equal(withoutRuaUri(added, ADDRESS), record);
});

test("removes only our uri, and the tag itself when it becomes empty", () => {
	assert.equal(withoutRuaUri(`v=DMARC1; p=none; rua=${URI}`, ADDRESS), "v=DMARC1; p=none");
	assert.equal(withoutRuaUri(`v=DMARC1; rua=${URI}; p=none`, ADDRESS), "v=DMARC1; p=none");
	assert.equal(withoutRuaUri(`v=DMARC1; p=none; rua=mailto:a@x.org,${URI}`, ADDRESS), "v=DMARC1; p=none; rua=mailto:a@x.org");
	assert.equal(withoutRuaUri(`v=DMARC1; p=none; rua=${URI}, mailto:a@x.org!10m`, ADDRESS), "v=DMARC1; p=none; rua=mailto:a@x.org!10m");
	assert.equal(withoutRuaUri(`v=DMARC1; p=none; rua=${URI};`, ADDRESS), "v=DMARC1; p=none;");
});

test("removing when our uri is not there changes nothing", () => {
	for (const record of ["v=DMARC1; p=none", "v=DMARC1; p=none; rua=mailto:a@x.org"]) assert.equal(withoutRuaUri(record, ADDRESS), record);
});

test("hasRuaUri reads the tag case-insensitively", () => {
	assert.equal(hasRuaUri(`v=DMARC1; p=none; rua=${URI}`, ADDRESS), true);
	assert.equal(hasRuaUri(`v=DMARC1; p=none; rua=mailto:a@x.org`, ADDRESS), false);
	assert.equal(hasRuaUri("v=DMARC1; p=none", ADDRESS), false);
	assert.equal(hasRuaUri(`v=DMARC1; ruf=${URI}`, ADDRESS), false, "a ruf destination is not a rua destination");
});

test("input that is not a DMARC record is refused", () => {
	for (const record of ["", "v=spf1 -all", "p=none; rua=mailto:a@x.org", "v=DMARC10; p=none"]) {
		assert.throws(() => withRuaUri(record, ADDRESS), /not a DMARC record/i, record);
		assert.throws(() => withoutRuaUri(record, ADDRESS), /not a DMARC record/i, record);
	}
});

test("the address is validated so nothing else can be injected into the record", () => {
	for (const bad of ["a@b.com; p=none", "a@b.com,mailto:evil@x.org", "a b@c.com", ""]) assert.throws(() => withRuaUri("v=DMARC1; p=none", bad), /address/i, bad);
});

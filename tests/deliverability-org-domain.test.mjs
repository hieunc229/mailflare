import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-org-domain-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: { org: join(root, "src/lib/deliverability/org-domain.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { organisationalDomain, addressOrganisation } = await import(pathToFileURL(join(outDir, "org.mjs")).href);

test("the organisational domain follows the Public Suffix List, private suffixes included", () => {
	assert.equal(organisationalDomain("google.com"), "google.com");
	assert.equal(organisationalDomain("noreply.mail.Google.COM."), "google.com");
	assert.equal(organisationalDomain("a.b.example.co.uk"), "example.co.uk");
	assert.equal(organisationalDomain("example.co.uk"), "example.co.uk");
	assert.equal(organisationalDomain("a.example.me.uk"), "example.me.uk");
	assert.equal(organisationalDomain("a.example.com.au"), "example.com.au");
	assert.equal(organisationalDomain("a.b.example.eu.org"), "example.eu.org");
	assert.equal(organisationalDomain("victim.eu.org"), "victim.eu.org");
	assert.equal(organisationalDomain("eu.org"), null, "a public suffix is nobody's organisation");
	assert.equal(organisationalDomain("a.alice.github.io"), "alice.github.io", "private suffixes separate tenants");
	assert.notEqual(organisationalDomain("alice.github.io"), organisationalDomain("bob.github.io"));
	assert.equal(organisationalDomain("co.uk"), null);
	assert.equal(organisationalDomain("localhost"), null);
	assert.equal(organisationalDomain("192.0.2.1"), null);
	assert.equal(organisationalDomain("not a host"), null);
	assert.equal(organisationalDomain(""), null);
});

test("an address or From header yields its organisation only when it names exactly one address", () => {
	assert.equal(addressOrganisation("noreply-dmarc-support@google.com"), "google.com");
	assert.equal(addressOrganisation('"DMARC" <dmarcreport@mail.microsoft.com>'), "microsoft.com");
	assert.equal(addressOrganisation("a@victim.eu.org"), "victim.eu.org");
	assert.equal(addressOrganisation("a@google.com, b@evil.example"), null);
	assert.equal(addressOrganisation("no address"), null);
	assert.equal(addressOrganisation(null), null);
});

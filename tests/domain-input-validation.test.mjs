import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-domain-input-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { addDomainSchema, setupDomainSchema } from "./src/lib/validators.ts";`,
		resolveDir: root,
		sourcefile: "domain-input-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { addDomainSchema, setupDomainSchema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("hostnames lose case, spaces and the trailing dot", () => {
	assert.equal(addDomainSchema.parse({ hostname: "  Example.COM. " }).hostname, "example.com");
	assert.equal(setupDomainSchema.parse({ hostname: "mail.example.com." }).hostname, "mail.example.com");
});

test("internationalised hostnames become punycode", () => {
	assert.equal(addDomainSchema.parse({ hostname: "münchen.de" }).hostname, "xn--mnchen-3ya.de");
});

test("IP addresses are not domain names, including forms the URL parser normalises", () => {
	for (const hostname of ["1.2.3.4", "127.0.0.1", "0x7f.1", "0x7f.0.0.1", "2130706433", "192.168.1.1."]) {
		assert.equal(addDomainSchema.safeParse({ hostname }).success, false, hostname);
	}
	assert.equal(addDomainSchema.safeParse({ hostname: "mail1.example.com" }).success, true);
	assert.equal(addDomainSchema.safeParse({ hostname: "example.co" }).success, true);
});

test("hostnames with a scheme or spaces are rejected", () => {
	assert.equal(addDomainSchema.safeParse({ hostname: "https://example.com" }).success, false);
	assert.equal(addDomainSchema.safeParse({ hostname: "a b.com" }).success, false);
	assert.equal(addDomainSchema.safeParse({ hostname: "example" }).success, false);
});


import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-address-bare-angle-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { parseEmailAddressParts, getEmailAddressList, normalizeEmailAddress } from "./src/lib/email/address.ts";
			export { matchesRule } from "./src/lib/email/routing.ts";
		`,
		resolveDir: root,
		sourcefile: "address-bare-angle-entry.ts",
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
const { parseEmailAddressParts, getEmailAddressList, normalizeEmailAddress, matchesRule } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("an address in angle brackets without a display name loses the brackets", () => {
	assert.deepEqual(parseEmailAddressParts("<bob@example.com>"), { name: null, address: "bob@example.com" });
	assert.deepEqual(parseEmailAddressParts("  < bob@example.com >  "), { name: null, address: "bob@example.com" });
	assert.deepEqual(parseEmailAddressParts("Bob <bob@example.com>"), { name: "Bob", address: "bob@example.com" });
	assert.deepEqual(parseEmailAddressParts('"" <bob@example.com>'), { name: null, address: "bob@example.com" });
	assert.deepEqual(parseEmailAddressParts("bob@example.com"), { name: null, address: "bob@example.com" });
});

test("recipient dedup treats <bob@example.com> and bob@example.com as one address", () => {
	assert.equal(normalizeEmailAddress("<Bob@Example.com>"), "bob@example.com");
	assert.deepEqual(getEmailAddressList("<bob@example.com>, bob@example.com"), ["bob@example.com"]);
});

test("a sender rule matches a From header written as <address>", () => {
	const rule = { pattern: "bob@example.com", matchField: "sender", matchOperator: "exact", matchValue: "bob@example.com" };
	assert.equal(matchesRule(rule, { toAddress: "me@one.test", fromAddress: "<bob@example.com>" }), true);
});

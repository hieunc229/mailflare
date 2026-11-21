import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-thread-participant-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/email/address.ts")],
	outfile: join(outDir, "address.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { addressListIncludes } = await import(pathToFileURL(join(outDir, "address.mjs")).href);

test("a participant must match a whole address, not a substring", () => {
	assert.equal(addressListIncludes("user@example.com", "user@example.co"), false);
	assert.equal(addressListIncludes("bob@gmail.com", "ob@gmail.com"), false);
	assert.equal(addressListIncludes("Bob <bob@gmail.com>", "b@gmail.com"), false);
	assert.equal(addressListIncludes("bob@gmail.com", "b_b@gmail.com"), false);
	assert.equal(addressListIncludes("\"ob@gmail.com\" <bob@gmail.com>", "ob@gmail.com"), false);
});

test("exact addresses match in any header shape and case", () => {
	assert.equal(addressListIncludes("Bob <Bob@Gmail.com>, ann@x.com", "bob@gmail.com"), true);
	assert.equal(addressListIncludes("a@x.com, \"Doe, Jane\" <jane@x.com>", " JANE@x.com "), true);
	assert.equal(addressListIncludes(null, "a@x.com"), false);
	assert.equal(addressListIncludes("a@x.com", ""), false);
});

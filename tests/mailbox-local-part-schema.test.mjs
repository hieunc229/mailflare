import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-mailbox-local-part-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { mailboxSchema } from "./src/lib/validators.ts";`,
		resolveDir: root,
		sourcefile: "mailbox-local-part-entry.ts",
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
const { mailboxSchema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("mailbox local parts use the same characters as the other schemas", () => {
	const input = (localPart) => ({ domainId: "d", localPart });
	assert.equal(mailboxSchema.safeParse(input("john.doe+tag")).success, true);
	assert.equal(mailboxSchema.safeParse(input("bob smith")).success, false);
	assert.equal(mailboxSchema.safeParse(input("a@b")).success, false);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-profile-schema-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: { contents: `export { updateProfileSchema } from "./src/lib/validators.ts";`, resolveDir: root, sourcefile: "profile-schema-entry.ts" },
	outfile: join(directory, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node24",
	tsconfig: join(root, "tsconfig.json"), packages: "external", logLevel: "silent",
});
const { updateProfileSchema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("a recovery-email-only save carries no name", () => {
	const parsed = updateProfileSchema.parse({ resetEmail: "me@example.com" });
	assert.equal(parsed.name, undefined);
	assert.equal(parsed.resetEmail, "me@example.com");
});

test("a supplied name is still trimmed and validated", () => {
	assert.equal(updateProfileSchema.parse({ name: "  Alex ", resetEmail: "" }).name, "Alex");
	assert.throws(() => updateProfileSchema.parse({ name: "  ", resetEmail: "" }));
});

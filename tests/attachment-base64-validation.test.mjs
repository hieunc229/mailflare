import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-base64-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/validators.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
});
const { sendEmailSchema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const withAttachment = (contentBase64) => ({
	from: "me@example.com",
	to: "a@example.com",
	subject: "s",
	text: "t",
	mailboxId: "m1",
	attachments: [{ filename: "f.txt", contentBase64 }],
});

test("valid base64 attachments pass, with or without line breaks", () => {
	for (const value of ["aGVsbG8=", "aGVsbG8gd29ybGQ=", "aGVs\nbG8=", "YWJj", "YQ"]) {
		assert.equal(sendEmailSchema.safeParse(withAttachment(value)).success, true, value);
	}
});

test("invalid base64 is rejected by the schema instead of failing later in atob", () => {
	for (const value of ["not base64!", "aGVsbG8-_w", "YQ=", "Y", "=YQ="]) {
		assert.equal(sendEmailSchema.safeParse(withAttachment(value)).success, false, value);
		assert.throws(() => atob(value.replace(/\s/g, "")), undefined, value);
	}
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-reset-origin-"));
await build({
	entryPoints: [join(root, "src/lib/auth/password-reset-utils.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { trustedResetOrigin } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
rmSync(directory, { recursive: true, force: true });

test("APP_URL decides the reset link origin whatever the request says", () => {
	assert.equal(trustedResetOrigin({ APP_URL: "https://mail.example.com/" }, "https://evil.example/api"), "https://mail.example.com");
	assert.equal(trustedResetOrigin({ APP_URL: "https://mail.example.com", MAILFLARE_RUNTIME: "node" }, "http://evil.example/api"), "https://mail.example.com");
});

test("the self-hosted server without APP_URL has no trusted origin", () => {
	assert.equal(trustedResetOrigin({ MAILFLARE_RUNTIME: "node" }, "http://evil.example/api"), null);
	assert.equal(trustedResetOrigin({ APP_URL: "  ", MAILFLARE_RUNTIME: "node" }, "http://evil.example/api"), null);
});

test("a malformed APP_URL sends nothing", () => {
	assert.equal(trustedResetOrigin({ APP_URL: "not a url" }, "https://mail.example.com/api"), null);
});

test("Workers without APP_URL use the request origin", () => {
	assert.equal(trustedResetOrigin({}, "https://mail.example.com/api/auth/password-reset/request"), "https://mail.example.com");
});

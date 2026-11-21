import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-outbound-retry-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { isPermanentDeliveryError } from "./src/lib/email/send.ts";
		`,
		resolveDir: root,
		sourcefile: "outbound-retry-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
});

const { isPermanentDeliveryError } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("outbound retry: isPermanentDeliveryError classifies transient network and rate limit errors", () => {
	// Transient HTTP statuses
	assert.equal(isPermanentDeliveryError({ status: 429, message: "Too many requests" }), false);
	assert.equal(isPermanentDeliveryError({ status: 500, message: "Internal server error" }), false);
	assert.equal(isPermanentDeliveryError({ status: 502, message: "Bad Gateway" }), false);
	assert.equal(isPermanentDeliveryError({ status: 503, message: "Service Unavailable" }), false);
	assert.equal(isPermanentDeliveryError({ status: 504, message: "Gateway Timeout" }), false);

	// Transient error message substrings
	assert.equal(isPermanentDeliveryError(new Error("fetch failed")), false);
	assert.equal(isPermanentDeliveryError(new Error("Connection timeout")), false);
	assert.equal(isPermanentDeliveryError(new Error("read ECONNRESET")), false);
	assert.equal(isPermanentDeliveryError(new Error("Rate limit exceeded")), false);
	assert.equal(isPermanentDeliveryError(new Error("Service temporarily unavailable")), false);
});

test("outbound retry: isPermanentDeliveryError classifies non-retryable permanent client errors", () => {
	// Permanent HTTP statuses
	assert.equal(isPermanentDeliveryError({ status: 400, message: "Bad Request" }), true);
	assert.equal(isPermanentDeliveryError({ status: 401, message: "Unauthorized" }), true);
	assert.equal(isPermanentDeliveryError({ status: 403, message: "Forbidden" }), true);
	assert.equal(isPermanentDeliveryError({ status: 404, message: "Not Found" }), true);
	assert.equal(isPermanentDeliveryError({ status: 422, message: "Unprocessable Entity" }), true);

	// Permanent error message substrings
	assert.equal(isPermanentDeliveryError(new Error("Invalid recipient email address")), true);
	assert.equal(isPermanentDeliveryError(new Error("Domain not verified in Resend")), true);
	assert.equal(isPermanentDeliveryError(new Error("Sender unauthorized")), true);
	assert.equal(isPermanentDeliveryError(new Error("Message exceeds limit")), true);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The module under test imports through the `@/*` alias and is TypeScript, so it is bundled with the
 * esbuild already used by `scripts/build-server.mjs` rather than loaded directly. Nothing here
 * touches a Workers binding: `validateRequest` only inspects the decoded request object.
 */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-jmap-capabilities-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { SUPPORTED_CAPABILITIES, validateRequest } from "./src/lib/jmap/processor.ts";`,
		resolveDir: root,
		sourcefile: "jmap-capabilities-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { SUPPORTED_CAPABILITIES, validateRequest } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const request = (using) => ({ using, methodCalls: [["Core/echo", { echo: true }, "c0"]] });

test("accepts the capabilities the server advertises", () => {
	for (const capability of SUPPORTED_CAPABILITIES) {
		assert.deepEqual(validateRequest(request([capability])).using, [capability]);
	}
});

test("ignores an unimplemented IETF extension capability", () => {
	const using = [...SUPPORTED_CAPABILITIES, "urn:ietf:params:jmap:vacationresponse"];
	assert.deepEqual(validateRequest(request(using)).using, using);
});

test("ignores an unimplemented IETF extension alongside capabilities we do not implement calls for", () => {
	const request_ = {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:vacationresponse"],
		methodCalls: [
			["VacationResponse/get", {}, "c0"],
			["Core/echo", { echo: true }, "c1"],
		],
	};
	assert.equal(validateRequest(request_).methodCalls.length, 2);
});

test("still rejects an unknown capability from another namespace", () => {
	assert.throws(() => validateRequest(request([...SUPPORTED_CAPABILITIES, "https://example.com/apis/foobar"])), (error) => {
		assert.equal(error.type, "unknownCapability");
		assert.equal(error.message, "https://example.com/apis/foobar");
		return true;
	});
});

test("still rejects a request that is not a request object", () => {
	assert.throws(() => validateRequest({ using: ["urn:ietf:params:jmap:core"] }), { type: "notRequest" });
	assert.throws(() => validateRequest(null), { type: "notRequest" });
});
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-jmap-request-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/jmap/request-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { parsePingSeconds, tryDecodeURIComponent } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a malformed percent escape is reported instead of thrown", () => {
	assert.equal(tryDecodeURIComponent("100% done.pdf"), null);
	assert.equal(tryDecodeURIComponent("caf%C3%A9.pdf"), "café.pdf");
});

test("the eventsource ping is clamped to a finite value of at least 10 seconds", () => {
	assert.equal(parsePingSeconds(null), 30);
	assert.equal(parsePingSeconds("abc"), 30);
	assert.equal(parsePingSeconds("Infinity"), 30);
	assert.equal(parsePingSeconds("3"), 10);
	assert.equal(parsePingSeconds("45"), 45);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-takeout-card-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { c: join(root, "src/components/settings/takeout-calendar-card-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { radioTarget, resultTone } = await import(pathToFileURL(join(dir, "c.mjs")).href);

test("radio group keys move and wrap like a native radio group", () => {
	assert.equal(radioTarget("ArrowRight", 0, 5), 1);
	assert.equal(radioTarget("ArrowDown", 4, 5), 0);
	assert.equal(radioTarget("ArrowLeft", 0, 5), 4);
	assert.equal(radioTarget("ArrowUp", 3, 5), 2);
	assert.equal(radioTarget("Home", 3, 5), 0);
	assert.equal(radioTarget("End", 1, 5), 4);
	assert.equal(radioTarget("Tab", 1, 5), null);
	assert.equal(radioTarget("a", 1, 5), null);
});

test("the results box says success, partial or failed", () => {
	const summary = (over) => ({ events: 0, series: 0, imported: 0, skipped: 0, simplified: 0, guessedZone: 0, failed: 0, errors: [], aborted: false, rateLimited: false, ...over });
	const run = (mode, over) => ({ id: "a", label: "a", mode, summary: summary(over) });
	assert.equal(resultTone([run("import", { imported: 5 })]), "success");
	assert.equal(resultTone([run("import", { skipped: 5 })]), "success");
	assert.equal(resultTone([run("preview", { events: 3 })]), "success");
	assert.equal(resultTone([run("import", { imported: 5, failed: 1 })]), "partial");
	assert.equal(resultTone([run("import", { imported: 5 }), run("import", { failed: 2 })]), "partial");
	assert.equal(resultTone([run("import", { imported: 5, aborted: true })]), "partial");
	assert.equal(resultTone([run("import", { imported: 5, rateLimited: true })]), "partial");
	assert.equal(resultTone([run("import", { rateLimited: true })]), "failed");
	assert.equal(resultTone([run("import", { failed: 3 })]), "failed");
	assert.equal(resultTone([run("import", { failed: 3 }), run("import", { failed: 1 })]), "failed");
	// An import counts every event of the file in `events`, so only imported and skipped show that something worked.
	assert.equal(resultTone([run("import", { events: 3, failed: 3 })]), "failed");
	assert.equal(resultTone([run("preview", { events: 3, failed: 1 })]), "partial");
});

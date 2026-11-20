import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-promotions-mode-utils-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { parseModeBody, backfillPatchForModeChange, describeBackfill, isSilentPromotion } from "./src/lib/promotions/mode-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "entry.ts",
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
const u = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("parseModeBody accepts only the three modes", () => {
	assert.deepEqual(u.parseModeBody({ mode: "separate" }), { mode: "separate" });
	for (const bad of [null, {}, { mode: "on" }, { mode: 1 }, "show", []]) assert.ok("error" in u.parseModeBody(bad));
});

test("the first move away from off queues the backfill; failed or idle restarts clean", () => {
	assert.deepEqual(u.backfillPatchForModeChange(null, "off"), { backfillStatus: "idle" });
	assert.deepEqual(u.backfillPatchForModeChange(null, "show"), { backfillStatus: "pending", backfillStalls: 0, backfillError: null, backfillCursor: null, backfillScanned: 0 });
	assert.deepEqual(u.backfillPatchForModeChange({ mode: "off", backfillStatus: "failed" }, "separate"), { backfillStatus: "pending", backfillStalls: 0, backfillError: null, backfillCursor: null, backfillScanned: 0 });
	assert.deepEqual(u.backfillPatchForModeChange({ mode: "off", backfillStatus: "idle" }, "show"), { backfillStatus: "pending", backfillStalls: 0, backfillError: null, backfillCursor: null, backfillScanned: 0 });
});

test("other changes leave the backfill alone", () => {
	for (const status of ["pending", "running", "done"]) assert.deepEqual(u.backfillPatchForModeChange({ mode: "off", backfillStatus: status }, "show"), {});
	assert.deepEqual(u.backfillPatchForModeChange({ mode: "show", backfillStatus: "done" }, "separate"), {});
	assert.deepEqual(u.backfillPatchForModeChange({ mode: "show", backfillStatus: "done" }, "off"), {});
});

test("describeBackfill reports status, scanned and the error only when failed", () => {
	assert.deepEqual(u.describeBackfill(null), { status: "idle", scanned: 0 });
	assert.deepEqual(u.describeBackfill({ backfillStatus: "running", backfillScanned: 40, backfillError: "x" }), { status: "running", scanned: 40 });
	assert.deepEqual(u.describeBackfill({ backfillStatus: "failed", backfillScanned: 40, backfillError: "boom" }), { status: "failed", scanned: 40, error: "boom" });
});

test("only promotions in a separate mailbox are silent", () => {
	assert.equal(u.isSilentPromotion("promotions", "separate"), true);
	assert.equal(u.isSilentPromotion("promotions", "show"), false);
	assert.equal(u.isSilentPromotion("promotions", "off"), false);
	assert.equal(u.isSilentPromotion("promotions", undefined), false);
	assert.equal(u.isSilentPromotion(null, "separate"), false);
});

test("saving a non-off mode while the backfill failed requeues it (Try again)", () => {
	const clean = { backfillStatus: "pending", backfillStalls: 0, backfillError: null, backfillCursor: null, backfillScanned: 0 };
	assert.deepEqual(u.backfillPatchForModeChange({ mode: "show", backfillStatus: "failed" }, "show"), clean);
	assert.deepEqual(u.backfillPatchForModeChange({ mode: "separate", backfillStatus: "failed" }, "separate"), clean);
	assert.deepEqual(u.backfillPatchForModeChange({ mode: "show", backfillStatus: "failed" }, "off"), {});
});

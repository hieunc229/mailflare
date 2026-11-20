import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-drive-card-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { c: join(root, "src/components/settings/takeout-drive-card-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { canStartDrive, defaultDriveRoot, driveTone, folderOptions, freeStorage, isLargeImport, LARGE_IMPORT_FILES, newFolderName, topFolders } = await import(pathToFileURL(join(dir, "c.mjs")).href);

const rootOf = (label) => ({ key: `Takeout/${label}`, prefix: ["Takeout", label], label, files: 1, bytes: 1, tooMany: false });

test("the Drive folder is chosen for the user, any other folder only when it is the only one", () => {
	assert.equal(defaultDriveRoot([rootOf("My Activity"), rootOf("Drive")]), "Takeout/Drive");
	assert.equal(defaultDriveRoot([rootOf("drive")]), "Takeout/drive");
	assert.equal(defaultDriveRoot([rootOf("Laufwerk")]), "Takeout/Laufwerk");
	assert.equal(defaultDriveRoot([rootOf("Laufwerk"), rootOf("My Activity")]), "");
	assert.equal(defaultDriveRoot([]), "");
});

test("the new folder is named after the day", () => {
	assert.equal(newFolderName(new Date(2026, 10, 21, 23, 59)), "Google Drive (2026-11-21)");
	assert.equal(newFolderName(new Date(2026, 0, 5)), "Google Drive (2026-01-05)");
});

test("existing folders are listed with their path, sorted, and a loop cannot hang it", () => {
	const options = folderOptions([
		{ id: "c", name: "Taxes", parentId: "a" }, { id: "a", name: "Docs", parentId: null }, { id: "b", name: "Art", parentId: null },
		{ id: "x", name: "Loop A", parentId: "y" }, { id: "y", name: "Loop B", parentId: "x" }, { id: "o", name: "Orphan", parentId: "missing" },
	]);
	assert.deepEqual(options.slice(0, 3), [{ id: "b", label: "Art" }, { id: "a", label: "Docs" }, { id: "c", label: "Docs / Taxes" }]);
	assert.ok(options.some((option) => option.id === "o"));
});

test("free storage is the limit minus what is used, or unknown without a limit", () => {
	assert.equal(freeStorage(100, 300), 200);
	assert.equal(freeStorage(500, 300), 0);
	assert.equal(freeStorage(100, null), null);
	assert.equal(freeStorage(undefined, 300), null);
});

const summary = (over) => ({ total: 0, imported: 0, skipped: 0, failed: 0, tooDeep: 0, bytes: 0, errors: [], aborted: false, storageFull: false, stoppedAfterFailures: false, ...over });

test("the results box says success, partial or failed", () => {
	assert.equal(driveTone(summary({ imported: 3 })), "success");
	assert.equal(driveTone(summary({ skipped: 3 })), "success");
	assert.equal(driveTone(summary({ imported: 3, failed: 1 })), "partial");
	assert.equal(driveTone(summary({ imported: 3, aborted: true })), "partial");
	assert.equal(driveTone(summary({ imported: 3, storageFull: true })), "partial");
	assert.equal(driveTone(summary({ failed: 3 })), "failed");
	assert.equal(driveTone(summary({ storageFull: true, failed: 1 })), "failed");
	assert.equal(driveTone(summary({ imported: 3, failed: 5, stoppedAfterFailures: true })), "partial");
	assert.equal(driveTone(summary({ failed: 5, stoppedAfterFailures: true })), "failed");
});

test("a very large import is one over 5,000 files", () => {
	assert.equal(LARGE_IMPORT_FILES, 5000);
	assert.equal(isLargeImport(5000), false);
	assert.equal(isLargeImport(5001), true);
	assert.equal(isLargeImport(0), false);
});

test("the folders at the top of a Takeout folder are listed with their file counts, loose files left out", () => {
	const file = (...segments) => ({ segments });
	assert.deepEqual(topFolders([file("b", "x.txt"), file("a", "c", "y.txt"), file("b", "z.txt"), file("loose.txt")]), [{ name: "a", files: 1 }, { name: "b", files: 2 }]);
	assert.deepEqual(topFolders([file("loose.txt")]), []);
});

test("Import is on only for a chosen folder that was not cut short, with files, and not while running", () => {
	assert.equal(canStartDrive(3, false, { tooMany: false }), true);
	assert.equal(canStartDrive(0, false, { tooMany: false }), false);
	assert.equal(canStartDrive(3, true, { tooMany: false }), false);
	assert.equal(canStartDrive(3, false, undefined), false);
	// Another folder of the export being cut short does not matter: only the chosen one is passed.
	assert.equal(canStartDrive(3, false, { tooMany: true }), false);
});

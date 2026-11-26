import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-sharing-backup-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { backups: join(root, "src/lib/backups/export.ts"), groups: join(root, "src/lib/backups/table-groups.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@": join(root, "src") },
});
const { BACKUP_TABLES } = await import(pathToFileURL(join(dir, "backups.mjs")).href);
const { BACKUP_TABLE_GROUPS } = await import(pathToFileURL(join(dir, "groups.mjs")).href);
const groupOf = (table) => BACKUP_TABLE_GROUPS.filter((group) => group.tables.includes(table)).map((group) => group.id);
const at = (table) => BACKUP_TABLES.indexOf(table);

test("the sharing tables are backed up, each in exactly one group (spec 8.10)", () => {
	assert.deepEqual(groupOf("calendar_shares"), ["accounts"]);
	assert.deepEqual(groupOf("calendar_resources"), ["accounts"]);
	assert.deepEqual(groupOf("calendar_resource_bookings"), ["mail"]);
});

test("backup order keeps parents before children", () => {
	assert.ok(at("dav_collections") >= 0 && at("dav_collections") < at("calendar_shares"));
	assert.ok(at("users") < at("calendar_shares"));
	assert.ok(at("calendar_resources") >= 0 && at("calendar_resources") < at("calendar_resource_bookings"));
	assert.ok(at("calendar_events") >= 0 && at("calendar_events") < at("calendar_resource_bookings"));
	assert.ok(at("users") < at("calendar_resources"));
});

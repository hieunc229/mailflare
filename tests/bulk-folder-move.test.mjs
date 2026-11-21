import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-bulk-folder-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/app/api/messages/bulk/utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { canMoveToFolder } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a bulk folder move takes mail from the folder's own mailbox, but never drafts", () => {
	assert.equal(canMoveToFolder({ mailboxId: "A", status: "received" }, "A"), true);
	assert.equal(canMoveToFolder({ mailboxId: "A", status: "sent" }, "A"), true);
	assert.equal(canMoveToFolder({ mailboxId: "B", status: "received" }, "A"), false);
	assert.equal(canMoveToFolder({ mailboxId: "A", status: "draft" }, "A"), false);
	assert.equal(canMoveToFolder({ mailboxId: null, status: "received" }, "A"), false);
});

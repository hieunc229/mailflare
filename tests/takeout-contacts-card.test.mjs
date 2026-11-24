import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-contacts-card-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { c: join(root, "src/components/settings/takeout-contacts-card-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { contactsTone, isAddressBookOwner } = await import(pathToFileURL(join(dir, "c.mjs")).href);

const summary = (over) => ({ cards: 0, withEmail: 0, noEmail: 0, noEmailNames: [], created: 0, updated: 0, unchanged: 0, failed: 0, errors: [], photosUploaded: 0, photosFailed: 0, aborted: false, rateLimited: false, ...over });
const result = (mode, over) => ({ id: "a", label: "a", mode, photos: true, summary: summary(over) });

test("the results box says success, partial or failed", () => {
	assert.equal(contactsTone([result("import", { created: 5 })]), "success");
	assert.equal(contactsTone([result("import", { unchanged: 5 })]), "success");
	assert.equal(contactsTone([result("preview", { withEmail: 5 })]), "success");
	assert.equal(contactsTone([result("import", { created: 5, failed: 1 })]), "partial");
	assert.equal(contactsTone([result("import", { created: 5, photosFailed: 1 })]), "partial");
	assert.equal(contactsTone([result("import", { created: 5, aborted: true })]), "partial");
	assert.equal(contactsTone([result("import", { created: 5, rateLimited: true })]), "partial");
	assert.equal(contactsTone([result("import", { failed: 5 })]), "failed");
	assert.equal(contactsTone([result("import", { created: 5 }), result("import", { failed: 2 })]), "partial");
});

test("only the owner of an address book can import into it", () => {
	assert.equal(isAddressBookOwner({ userId: "u1" }, "u1"), true);
	assert.equal(isAddressBookOwner({ userId: "u2" }, "u1"), false);
	// Unknown owner or user: let the server decide (it answers 404 to a delegate).
	assert.equal(isAddressBookOwner({}, "u1"), true);
	assert.equal(isAddressBookOwner({ userId: "u1" }, undefined), true);
	assert.equal(isAddressBookOwner(null, "u1"), true);
});

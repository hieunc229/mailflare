import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Adding a domain records the signed-in user as its owner, so a mailbox manager's
// domain list must include their own id as well as their creator's.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-list-owners-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/domains/utils.ts")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "neutral",
	logLevel: "silent",
});
const { domainListOwnerIds } = await import(pathToFileURL(outfile).href);

test("a mailbox manager sees their own domains and their creator's", () => {
	assert.deepEqual(
		domainListOwnerIds({ id: "usr_manager", canManageMailboxes: true, createdByUserId: "usr_creator" }),
		["usr_manager", "usr_creator"],
	);
});

test("an account without mailbox management sees only its own domains", () => {
	assert.deepEqual(
		domainListOwnerIds({ id: "usr_member", canManageMailboxes: false, createdByUserId: "usr_creator" }),
		["usr_member"],
	);
});

test("an account nobody created sees only its own domains", () => {
	assert.deepEqual(domainListOwnerIds({ id: "usr_admin", canManageMailboxes: true, createdByUserId: null }), ["usr_admin"]);
});

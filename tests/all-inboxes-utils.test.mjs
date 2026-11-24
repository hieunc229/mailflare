import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-all-inboxes-utils-"));
await build({
	stdin: {
		contents: `export { getMailboxChips, shouldShowAllInboxes } from "./src/components/messages/all-inboxes-utils.ts";`,
		resolveDir: root,
		sourcefile: "all-inboxes-utils-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { getMailboxChips, shouldShowAllInboxes } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
rmSync(bundleDirectory, { recursive: true, force: true });

const mailbox = (id, localPart, displayName = null) => ({ id, localPart, hostname: "example.com", displayName });

test("the All inboxes entry needs at least two mailboxes", () => {
	assert.equal(shouldShowAllInboxes([]), false);
	assert.equal(shouldShowAllInboxes([mailbox("a", "support")]), false);
	assert.equal(shouldShowAllInboxes([mailbox("a", "support"), mailbox("b", "billing")]), true);
});

test("a chip shows the display name, else the local part, and the full address on hover", () => {
	const chips = getMailboxChips([mailbox("a", "support", "Support"), mailbox("b", "billing"), mailbox("c", "sales", "  ")]);
	assert.deepEqual([...chips.keys()], ["a", "b", "c"]);
	assert.equal(chips.get("a").label, "Support");
	assert.equal(chips.get("b").label, "billing");
	assert.equal(chips.get("c").label, "sales", "a blank display name falls back to the local part");
	assert.equal(chips.get("b").title, "billing@example.com");
});

test("the first six mailboxes get six different chip colours", () => {
	const mailboxes = Array.from({ length: 7 }, (_, index) => mailbox(`m${index}`, `box${index}`));
	const colours = [...getMailboxChips(mailboxes).values()].map((chip) => chip.className);
	assert.equal(new Set(colours.slice(0, 6)).size, 6);
	assert.equal(colours[6], colours[0], "the seventh reuses the first tint");
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-message-actions-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { getMessageActionRedirect } from "./src/components/message-actions/utils.ts";
export { getAutoAdvanceId } from "./src/components/messages/message-detail-navigation-utils.ts";`,
		resolveDir: root,
		sourcefile: "message-action-redirect-entry.ts",
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
const { getMessageActionRedirect, getAutoAdvanceId } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("moving a message sends the reader back to the list they opened it from", () => {
	for (const action of ["trash", "spam", "archive", "inbox"]) {
		assert.equal(getMessageActionRedirect(action, "/inbox"), "/inbox");
		assert.equal(getMessageActionRedirect(action, "/spam"), "/spam");
	}
});

test("actions that leave the message in place do not navigate", () => {
	for (const action of ["read", "unread", "delete"]) assert.equal(getMessageActionRedirect(action, "/inbox"), null);
});

test("auto-advance opens the email below in the list, else the one above", () => {
	// Newest first, as the list shows them. Unread state must not reorder them.
	const entries = [
		{ id: "a", unread: false },
		{ id: "b", unread: true },
		{ id: "c", unread: true },
		{ id: "d", unread: false },
	];
	assert.equal(getAutoAdvanceId(entries, "a"), "b");
	assert.equal(getAutoAdvanceId(entries, "b"), "c");
	assert.equal(getAutoAdvanceId(entries, "d"), "c");
	assert.equal(getAutoAdvanceId([{ id: "a", unread: false }], "a"), null);
	assert.equal(getAutoAdvanceId(entries, "missing"), null);
});

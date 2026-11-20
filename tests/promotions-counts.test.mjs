import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-promotion-counts-"));
after(() => rmSync(temp, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { activePromotionModes, applyPromotionCounts, buildMessageCounts, createEmptyFolderCounts } from "./src/app/api/messages/counts/utils.ts";`,
		resolveDir: root,
		sourcefile: "promotion-counts-entry.ts",
		loader: "ts",
	},
	outfile: join(temp, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { activePromotionModes, applyPromotionCounts, buildMessageCounts, createEmptyFolderCounts } = await import(pathToFileURL(join(temp, "entry.mjs")).href);

const inboxRow = (mailboxId, read, total) => ({ mailboxId, folderId: null, direction: "inbound", status: "received", read, starred: false, snoozedUntil: null, total });

test("every folder count starts with a promotions entry at zero", () => {
	assert.deepEqual(createEmptyFolderCounts().promotions, { total: 0, unread: 0 });
	assert.deepEqual(buildMessageCounts([]).folders.promotions, { total: 0, unread: 0 });
});

test("show mode fills promotions and leaves Inbox alone", () => {
	const counts = buildMessageCounts([inboxRow("a", false, 3), inboxRow("a", true, 2)]);
	applyPromotionCounts(counts, [{ mailboxId: "a", read: false, total: 2 }, { mailboxId: "a", read: true, total: 1 }], new Set());
	assert.deepEqual(counts.folders.promotions, { total: 3, unread: 2 });
	assert.deepEqual(counts.folders.inbox, { total: 5, unread: 3 });
	assert.equal(counts.mailboxes[0].inbox, 5);
});

test("separate mode moves promotions out of Inbox totals, unread and per-mailbox inbox", () => {
	const counts = buildMessageCounts([inboxRow("a", false, 3), inboxRow("a", true, 2), inboxRow("b", false, 4)]);
	applyPromotionCounts(counts, [{ mailboxId: "a", read: false, total: 2 }, { mailboxId: "a", read: true, total: 1 }, { mailboxId: "b", read: false, total: 1 }], new Set(["a"]));
	assert.deepEqual(counts.folders.promotions, { total: 4, unread: 3 });
	assert.deepEqual(counts.folders.inbox, { total: 9 - 3, unread: 7 - 2 });
	assert.equal(counts.mailboxes.find((m) => m.mailboxId === "a").inbox, 2);
	assert.equal(counts.mailboxes.find((m) => m.mailboxId === "b").inbox, 4);
});

test("activePromotionModes lists only mailboxes whose mode is not off", () => {
	const modes = new Map([["a", "show"], ["b", "off"], ["c", "separate"]]);
	assert.deepEqual(activePromotionModes(modes), { a: "show", c: "separate" });
	assert.deepEqual(activePromotionModes(new Map()), {});
});

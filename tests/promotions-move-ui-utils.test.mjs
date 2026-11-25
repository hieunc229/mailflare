import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-promotions-move-ui-"));
after(() => rmSync(temp, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export * from "./src/lib/promotions/move-utils.ts";`,
		resolveDir: root,
		sourcefile: "entry.ts",
		loader: "ts",
	},
	outfile: join(temp, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
});
const u = await import(pathToFileURL(join(temp, "entry.mjs")).href);

const base = { mode: "show", permission: "full_access", direction: "inbound", status: "received" };

test("the reader offers Move only inside the Inbox and Promotions views, like the list rows", () => {
	assert.equal(u.readerFolderOf("/inbox/abc"), "inbox");
	assert.equal(u.readerFolderOf("/inbox"), "inbox");
	assert.equal(u.readerFolderOf("/promotions/abc"), "promotions");
	for (const path of ["/sent/abc", "/trash/abc", "/spam/abc", "/archive/abc", "/starred/abc", "/folders/x/abc", "/search", "/inboxes/abc", "/promotions-old/abc", ""]) assert.equal(u.readerFolderOf(path), "other", path);
});

test("Move to Promotions / Inbox is offered only with Promotions on, full access and received mail", () => {
	assert.equal(u.canMoveCategory(base), true);
	assert.equal(u.canMoveCategory({ ...base, mode: "separate" }), true);
	assert.equal(u.canMoveCategory({ ...base, mode: "off" }), false);
	assert.equal(u.canMoveCategory({ ...base, mode: undefined }), false);
	for (const permission of ["read_only", "send_as", "send_on_behalf", undefined]) assert.equal(u.canMoveCategory({ ...base, permission }), false);
	assert.equal(u.canMoveCategory({ ...base, direction: "outbound" }), false);
	for (const status of ["trash", "spam", "archived", "sent", "draft"]) assert.equal(u.canMoveCategory({ ...base, status }), false);
});

test("a promotion moves to Inbox, everything else to Promotions", () => {
	assert.equal(u.moveTargetFor("promotions"), "inbox");
	for (const category of ["primary", null, undefined]) assert.equal(u.moveTargetFor(category), "promotions");
});

test("the Promotion chip shows on Inbox rows in show mode only", () => {
	assert.equal(u.showsPromotionChip({ folder: "inbox", mode: "show", category: "promotions" }), true);
	assert.equal(u.showsPromotionChip({ folder: "inbox", mode: "separate", category: "promotions" }), false);
	assert.equal(u.showsPromotionChip({ folder: "inbox", mode: undefined, category: "promotions" }), false);
	assert.equal(u.showsPromotionChip({ folder: "inbox", mode: "show", category: "primary" }), false);
	assert.equal(u.showsPromotionChip({ folder: "inbox", mode: "show", category: null }), false);
	assert.equal(u.showsPromotionChip({ folder: "promotions", mode: "show", category: "promotions" }), false);
	assert.equal(u.showsPromotionChip({ folder: "inbox", folderId: "f1", mode: "show", category: "promotions" }), false);
});

test("a moved message leaves the open folder only when the folder stops listing it", () => {
	assert.equal(u.moveLeavesFolder("promotions", "inbox", "show"), true);
	assert.equal(u.moveLeavesFolder("promotions", "inbox", "separate"), true);
	assert.equal(u.moveLeavesFolder("inbox", "promotions", "separate"), true);
	assert.equal(u.moveLeavesFolder("inbox", "promotions", "show"), false);
	assert.equal(u.moveLeavesFolder("inbox", "inbox", "show"), false);
});

test("runLimited never runs more than the limit at once and keeps order", async () => {
	let running = 0;
	let peak = 0;
	const results = await u.runLimited([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
		running += 1;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 5));
		running -= 1;
		if (n === 5) throw new Error("boom");
		return n * 2;
	});
	assert.equal(peak, 4);
	assert.deepEqual(results.map((r) => r.ok), [true, true, true, true, false, true, true, true, true]);
	assert.equal(results[2].value, 6);
	assert.equal(results[4].error.message, "boom");
	assert.deepEqual(await u.runLimited([], 4, async () => 1), []);
});

test("move results are summarised honestly: moved of total, rows changed, older left", () => {
	const ok = (changed, remainingOlder = 0) => ({ ok: true, value: { changed, remainingOlder } });
	const bad = { ok: false, error: new Error("x") };
	assert.deepEqual(u.summarizeMoves([ok(1), ok(0), bad, ok(1)]), { total: 4, moved: 3, failed: 1, changed: 2 });
	assert.deepEqual(u.summarizeMoves([]), { total: 0, moved: 0, failed: 0, changed: 0 });
});

test("toast copy: single, many, partial and failed moves", () => {
	assert.deepEqual(u.moveToastCopy("promotions", { total: 1, moved: 1, failed: 0, changed: 1 }), { key: "promotions.move.donePromotions" });
	assert.deepEqual(u.moveToastCopy("inbox", { total: 1, moved: 1, failed: 0, changed: 1 }), { key: "promotions.move.doneInbox" });
	assert.deepEqual(u.moveToastCopy("promotions", { total: 5, moved: 5, failed: 0, changed: 5 }), { key: "promotions.move.doneManyPromotions", vars: { count: 5 } });
	assert.deepEqual(u.moveToastCopy("inbox", { total: 5, moved: 5, failed: 0, changed: 5 }), { key: "promotions.move.doneManyInbox", vars: { count: 5 } });
	assert.deepEqual(u.moveToastCopy("promotions", { total: 5, moved: 3, failed: 2, changed: 3 }), { key: "promotions.move.partial", vars: { moved: 3, total: 5 } });
	assert.deepEqual(u.moveToastCopy("promotions", { total: 2, moved: 0, failed: 2, changed: 0 }), { key: "promotions.move.failed" });
});

test("the Always offer needs a sender, no failure and a message that moved", () => {
	assert.equal(u.canOfferAlways({ total: 1, moved: 1, failed: 0, changed: 1 }, "news@acme.com"), true);
	assert.equal(u.canOfferAlways({ total: 1, moved: 1, failed: 0, changed: 1 }, null), false);
	assert.equal(u.canOfferAlways({ total: 2, moved: 1, failed: 1, changed: 1 }, "news@acme.com"), false);
	assert.equal(u.canOfferAlways({ total: 1, moved: 0, failed: 1, changed: 0 }, "news@acme.com"), false);
});

test("the sender-rule result never claims everything moved", () => {
	assert.deepEqual(u.senderResultCopy({ changed: 12, remainingOlder: 40 }), { key: "promotions.always.resultOlder", vars: { changed: 12, remaining: 40 } });
	assert.deepEqual(u.senderResultCopy({ changed: 12, remainingOlder: 0 }), { key: "promotions.always.result", vars: { changed: 12 } });
	assert.deepEqual(u.senderResultCopy({ changed: 0, remainingOlder: 0 }), { key: "promotions.always.nothing" });
	assert.deepEqual(u.senderResultCopy({ changed: 0, remainingOlder: 7 }), { key: "promotions.always.resultOlder", vars: { changed: 0, remaining: 7 } });
});

test("the toast pauses on hover or focus and keeps the time it has left", () => {
	assert.equal(u.isToastPaused({ hover: false, focus: false }), false);
	assert.equal(u.isToastPaused({ hover: true, focus: false }), true);
	assert.equal(u.isToastPaused({ hover: false, focus: true }), true);
	assert.equal(u.remainingAfter(10000, 1000, 4000), 7000);
	assert.equal(u.remainingAfter(10000, 1000, 20000), 0);
	assert.equal(u.remainingAfter(10000, 1000, 500), 10000);
});

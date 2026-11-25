import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-list-membership-"));
after(() => rmSync(temp, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { messageMatchesFolder, getListMembershipContext } from "./src/lib/messages/list-membership.ts";
			export { getEmptyPageOffset } from "./src/components/messages/page-offset.ts";
		`,
		resolveDir: root,
		sourcefile: "membership-entry.ts",
		loader: "ts",
	},
	outfile: join(temp, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const { messageMatchesFolder, getListMembershipContext, getEmptyPageOffset } = await import(pathToFileURL(join(temp, "entry.mjs")).href);

function state(overrides = {}) {
	return {
		status: "received",
		folderId: null,
		snoozedUntil: null,
		starred: false,
		read: false,
		...overrides,
	};
}

const NOW = Date.parse("2026-11-14T12:00:00.000Z");

test("Starred ignores status, folder and snooze changes", () => {
	assert.equal(messageMatchesFolder(state({ starred: true }), "starred", null, NOW), true);
	assert.equal(messageMatchesFolder(state({ starred: true, status: "archived", folderId: "f1", snoozedUntil: "2026-11-14T13:00:00.000Z" }), "starred", null, NOW), true);
	assert.equal(messageMatchesFolder(state({ starred: false }), "starred", null, NOW), false);
});

test("inbox excludes custom folders and active snoozes", () => {
	assert.equal(messageMatchesFolder(state(), "inbox", null, NOW), true);
	assert.equal(messageMatchesFolder(state({ folderId: "f1" }), "inbox", null, NOW), false);
	assert.equal(messageMatchesFolder(state({ snoozedUntil: "2026-11-14T13:00:00.000Z" }), "inbox", null, NOW), false);
	assert.equal(messageMatchesFolder(state({ snoozedUntil: "2026-11-14T11:00:00.000Z" }), "inbox", null, NOW), true);
	assert.equal(messageMatchesFolder(state({ status: "archived" }), "inbox", null, NOW), false);
});

test("Snoozed requires a future time, received status and no folder", () => {
	assert.equal(messageMatchesFolder(state({ snoozedUntil: "2026-11-14T13:00:00.000Z" }), "snoozed", null, NOW), true);
	assert.equal(messageMatchesFolder(state({ snoozedUntil: "2026-11-14T11:00:00.000Z" }), "snoozed", null, NOW), false);
	assert.equal(messageMatchesFolder(state({ snoozedUntil: "2026-11-14T13:00:00.000Z", folderId: "f1" }), "snoozed", null, NOW), false);
	assert.equal(messageMatchesFolder(state({ snoozedUntil: "2026-11-14T13:00:00.000Z", status: "trash" }), "snoozed", null, NOW), false);
});

test("custom folders ignore snooze and only keep their own assignment", () => {
	assert.equal(messageMatchesFolder(state({ folderId: "f1", snoozedUntil: "2026-11-14T13:00:00.000Z" }), "inbox", "f1", NOW), true);
	assert.equal(messageMatchesFolder(state({ folderId: "f2" }), "inbox", "f1", NOW), false);
	assert.equal(messageMatchesFolder(state({ folderId: null, status: "archived" }), "inbox", "f1", NOW), false);
});

test("status folders track their own status", () => {
	for (const folder of ["archived", "trash", "spam"]) {
		assert.equal(messageMatchesFolder(state({ status: folder }), folder, null, NOW), true, folder);
		assert.equal(messageMatchesFolder(state({ status: "received" }), folder, null, NOW), false, folder);
	}
	assert.equal(messageMatchesFolder(state({ status: "sent" }), "sent", null, NOW), true);
	assert.equal(messageMatchesFolder(state({ status: "queued" }), "scheduled", null, NOW), true);
	assert.equal(messageMatchesFolder(state({ status: "draft" }), "drafts", null, NOW), true);
});

test("list keys resolve to the same query the server received", () => {
	assert.deepEqual(getListMembershipContext(new URLSearchParams({ direction: "inbound", status: "received" })), { folder: "inbox" });
	assert.deepEqual(getListMembershipContext("status=received&folderId=f1"), { folder: "inbox", folderId: "f1" });
	assert.deepEqual(getListMembershipContext("starred=true"), { folder: "starred" });
	assert.deepEqual(getListMembershipContext("snoozed=true"), { folder: "snoozed" });
	assert.deepEqual(getListMembershipContext("direction=outbound&status=sent"), { folder: "sent" });
	assert.deepEqual(getListMembershipContext("direction=outbound&scheduled=true"), { folder: "scheduled" });
	assert.deepEqual(getListMembershipContext("direction=outbound&status=draft"), { folder: "drafts" });
	assert.deepEqual(getListMembershipContext("status=trash"), { folder: "trash" });
	assert.equal(getListMembershipContext("limit=25"), null);
});

test("an emptied page waits for backfill unless it is out of range", () => {
	assert.equal(getEmptyPageOffset(0, 0, 25), null);
	assert.equal(getEmptyPageOffset(25, 75, 25), null);
	assert.equal(getEmptyPageOffset(25, 30, 25), null);
	assert.equal(getEmptyPageOffset(25, 25, 25), 0);
	assert.equal(getEmptyPageOffset(75, 75, 25), 50);
	assert.equal(getEmptyPageOffset(50, 0, 25), 0);
});

test("promotions holds received, unfiled, unsnoozed mail whose category is promotions", () => {
	const promo = state({ category: "promotions" });
	assert.equal(messageMatchesFolder(promo, "promotions", null, NOW), true);
	assert.equal(messageMatchesFolder(state(), "promotions", null, NOW), false);
	assert.equal(messageMatchesFolder(state({ category: null }), "promotions", null, NOW), false);
	assert.equal(messageMatchesFolder({ ...promo, folderId: "f1" }, "promotions", null, NOW), false);
	assert.equal(messageMatchesFolder({ ...promo, status: "trash" }, "promotions", null, NOW), false);
	assert.equal(messageMatchesFolder({ ...promo, snoozedUntil: "2026-11-14T13:00:00.000Z" }, "promotions", null, NOW), false);
	// Inbox membership does not depend on the category (the mailbox mode is unknown here).
	assert.equal(messageMatchesFolder(promo, "inbox", null, NOW), true);
});

test("a promotions list request maps back to the promotions folder", () => {
	assert.deepEqual(getListMembershipContext("direction=inbound&status=received&category=promotions"), { folder: "promotions" });
	assert.deepEqual(getListMembershipContext("direction=inbound&status=received"), { folder: "inbox" });
});
